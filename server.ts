import { createServer, IncomingMessage, ServerResponse } from 'http'
import { parse as parseUrl } from 'url'
import { Server } from 'socket.io'
import next from 'next'
import { PrismaClient } from './app/generated/prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import path from 'path'

// ---- DB ----
function getDbPath(): string {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db'
  const filePath = url.replace(/^file:/, '')
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
}
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: getDbPath() }) } as never)

// ---- HTTP helpers ----
function jsonRes(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}
function redirectRes(res: ServerResponse, location: string) {
  res.writeHead(302, { Location: location })
  res.end()
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
  })
}
function baseUrl(req: IncomingMessage): string {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() ?? 'http'
  return `${proto}://${req.headers.host}`
}

// ---- Google OAuth — handled here so process.env is read at request time ----
// (Next.js Route Handlers suffer Webpack static replacement at build time)
async function handleGoogleOAuth(
  req: IncomingMessage, res: ServerResponse,
  pathname: string, query: Record<string, string | string[] | undefined>
) {
  const clientId     = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI

  // GET /api/auth/google — start OAuth flow
  if (pathname === '/api/auth/google') {
    if (!clientId || !redirectUri) {
      const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']
        .filter(k => !process.env[k])
      console.error('[Google Auth] Missing env vars:', missing.join(', '))
      return jsonRes(res, { error: `Google Calendar not configured. Missing: ${missing.join(', ')}` }, 503)
    }
    const username = query.username as string | undefined
    if (!username) return jsonRes(res, { error: 'Missing username' }, 400)

    const state   = Buffer.from(JSON.stringify({ username })).toString('base64url')
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id',     clientId)
    authUrl.searchParams.set('redirect_uri',  redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope',         'https://www.googleapis.com/auth/calendar.readonly')
    authUrl.searchParams.set('access_type',   'offline')
    authUrl.searchParams.set('prompt',        'consent')
    authUrl.searchParams.set('state',         state)
    return redirectRes(res, authUrl.toString())
  }

  // GET /api/auth/google/callback — exchange code for tokens
  if (pathname === '/api/auth/google/callback') {
    const home  = baseUrl(req) + '/'
    const code  = query.code  as string | undefined
    const state = query.state as string | undefined
    const error = query.error as string | undefined

    if (error || !code || !state || !clientId || !clientSecret || !redirectUri) {
      return redirectRes(res, home + '?calendar_error=1')
    }

    let username: string
    try {
      username = JSON.parse(Buffer.from(state, 'base64url').toString()).username
      if (!username) throw new Error()
    } catch { return redirectRes(res, home + '?calendar_error=1') }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    })
    if (!tokenRes.ok) return redirectRes(res, home + '?calendar_error=1')

    const tokens   = await tokenRes.json()
    const existing = await prisma.userCalendar.findUnique({ where: { username } })
    await prisma.userCalendar.upsert({
      where:  { username },
      update: {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
      create: {
        username,
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token ?? existing?.refreshToken ?? '',
        expiresAt:    new Date(Date.now() + tokens.expires_in * 1000),
      },
    })
    return redirectRes(res, home + '?calendar_connected=1')
  }

  // GET /api/auth/google/status
  if (pathname === '/api/auth/google/status') {
    const username = query.username as string | undefined
    if (!username) return jsonRes(res, { connected: false })
    const cal = await prisma.userCalendar.findUnique({ where: { username } })
    return jsonRes(res, { connected: !!cal })
  }

  // POST /api/auth/google/disconnect
  if (pathname === '/api/auth/google/disconnect' && req.method === 'POST') {
    const body = await readBody(req)
    const username = body.username as string | undefined
    if (!username) return jsonRes(res, { error: 'Missing username' }, 400)
    await prisma.userCalendar.deleteMany({ where: { username } })
    return jsonRes(res, { ok: true })
  }

  jsonRes(res, { error: 'Not found' }, 404)
}

// ---- Google Calendar status polling ----
type CalRecord    = { username: string; accessToken: string; refreshToken: string; expiresAt: Date }
type MeetingStatus = { inMeeting: boolean; eventTitle: string; endTime: string }
let cachedStatuses: Record<string, MeetingStatus> = {}

async function getValidAccessToken(cal: CalRecord): Promise<string> {
  if (cal.expiresAt > new Date()) return cal.accessToken
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: cal.refreshToken,
      grant_type:    'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`)
  const t = await res.json()
  await prisma.userCalendar.update({
    where: { username: cal.username },
    data:  { accessToken: t.access_token, expiresAt: new Date(Date.now() + t.expires_in * 1000) },
  })
  return t.access_token
}

async function fetchMeetingStatus(cal: CalRecord): Promise<MeetingStatus> {
  const token = await getValidAccessToken(cal)
  const now   = new Date()
  const url   = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.searchParams.set('timeMin',      new Date(now.getTime() - 8 * 3600_000).toISOString())
  url.searchParams.set('timeMax',      new Date(now.getTime() +      60_000).toISOString())
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy',      'startTime')
  url.searchParams.set('maxResults',   '10')
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Calendar API error: ${res.status}`)
  const data   = await res.json()
  const active = (data.items ?? []).find((ev: any) => {
    if (!ev.start?.dateTime) return false
    return new Date(ev.start.dateTime) <= now && new Date(ev.end.dateTime) >= now
  })
  if (!active) return { inMeeting: false, eventTitle: '', endTime: '' }
  return { inMeeting: true, eventTitle: active.summary ?? '予定あり', endTime: active.end.dateTime }
}

// ---- App setup ----
const DEFAULT_CHANNELS = ['general']
const dev  = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT ?? '3000', 10)
const app  = next({ dev, port })
const handle = app.getRequestHandler()

async function seedChannels() {
  const count = await prisma.channel.count()
  if (count === 0) {
    await prisma.channel.createMany({ data: DEFAULT_CHANNELS.map((name) => ({ name })) })
  }
}

async function getChannelsForUser(username: string) {
  const channels = await prisma.channel.findMany({
    orderBy: { createdAt: 'asc' },
    include: { members: { select: { username: true } } },
  })
  return channels.filter((ch) => !ch.isPrivate || ch.members.some((m) => m.username === username))
}

app.prepare().then(async () => {
  await seedChannels()

  // Google OAuth routes are intercepted BEFORE Next.js to avoid Webpack env-var inlining
  const httpServer = createServer(async (req, res) => {
    const parsed   = parseUrl(req.url!, true)
    const pathname = parsed.pathname ?? ''

    if (pathname.startsWith('/api/auth/google')) {
      try {
        await handleGoogleOAuth(req, res, pathname, parsed.query as Record<string, string | undefined>)
      } catch (err) {
        console.error('[Google OAuth Error]', err)
        res.writeHead(500); res.end('Internal Server Error')
      }
      return
    }

    handle(req, res, parsed)
  })

  const io = new Server(httpServer)
  const connectedUsers = new Map<string, number>() // username → tab count
  function broadcastOnlineUsers() { io.emit('online_users', Array.from(connectedUsers.keys())) }

  async function refreshCalendarStatuses() {
    if (!process.env.GOOGLE_CLIENT_ID) return
    const calendars = await prisma.userCalendar.findMany()
    const next: Record<string, MeetingStatus> = {}
    for (const cal of calendars) {
      try {
        next[cal.username] = await fetchMeetingStatus(cal as CalRecord)
      } catch (err: any) {
        console.error(`Calendar fetch failed for ${cal.username}:`, err?.message)
        if (String(err?.message).includes('401')) {
          await prisma.userCalendar.deleteMany({ where: { username: cal.username } }).catch(() => {})
        }
      }
    }
    cachedStatuses = next
    io.emit('user_statuses', cachedStatuses)
  }

  if (process.env.GOOGLE_CLIENT_ID) {
    setTimeout(() => refreshCalendarStatuses(), 5_000)
    setInterval(() => refreshCalendarStatuses(), 5 * 60_000)
  }

  async function broadcastChannels() {
    const allChannels = await prisma.channel.findMany({
      orderBy: { createdAt: 'asc' },
      include: { members: { select: { username: true } } },
    })
    const sockets = await io.fetchSockets()
    for (const s of sockets) {
      const uname = (s.handshake.auth as { username?: string }).username
      if (!uname) continue
      s.emit('channel_list', allChannels.filter(
        (ch) => !ch.isPrivate || ch.members.some((m) => m.username === uname)
      ))
    }
  }

  async function broadcastProfiles() {
    const profiles = await prisma.userProfile.findMany()
    io.emit('user_profiles', Object.fromEntries(
      profiles.map((p) => [p.username, { avatarUrl: p.avatarUrl, email: p.email, title: p.title }])
    ))
  }

  async function emitNewMessage(channelId: number, isPrivate: boolean, memberUsernames: string[], message: object) {
    if (!isPrivate) { io.emit('new_message', message); return }
    const memberSet = new Set(memberUsernames)
    const sockets   = await io.fetchSockets()
    for (const s of sockets) {
      const uname = (s.handshake.auth as { username?: string }).username
      if (uname && memberSet.has(uname)) s.emit('new_message', message)
    }
  }

  io.on('connection', async (socket) => {
    const username = (socket.handshake.auth as { username?: string }).username ?? ''

    if (username) {
      connectedUsers.set(username, (connectedUsers.get(username) ?? 0) + 1)
      broadcastOnlineUsers()
    }
    socket.on('disconnect', () => {
      if (!username) return
      const n = (connectedUsers.get(username) ?? 1) - 1
      if (n <= 0) connectedUsers.delete(username); else connectedUsers.set(username, n)
      broadcastOnlineUsers()
    })

    socket.emit('user_statuses', cachedStatuses)
    socket.emit('online_users', Array.from(connectedUsers.keys()))
    socket.on('calendar_connected', () => refreshCalendarStatuses())

    const channels = await getChannelsForUser(username)
    socket.emit('channel_list', channels)

    const profiles = await prisma.userProfile.findMany()
    socket.emit('user_profiles', Object.fromEntries(
      profiles.map((p) => [p.username, { avatarUrl: p.avatarUrl, email: p.email, title: p.title }])
    ))

    if (channels.length > 0) {
      const rawMessages = await prisma.message.findMany({
        where: { channelId: channels[0].id, parentId: null },
        orderBy: { createdAt: 'asc' },
        take: 30,
        include: { _count: { select: { replies: true } } },
      })
      const messages = rawMessages.map(({ _count, ...m }) => ({ ...m, replyCount: _count.replies }))
      socket.emit('history', { channelId: channels[0].id, messages })
    }

    socket.on('join_channel', async (channelId: number) => {
      const channel = await prisma.channel.findUnique({
        where: { id: channelId }, include: { members: { select: { username: true } } },
      })
      if (!channel) return
      if (channel.isPrivate && !channel.members.some((m) => m.username === username)) return
      const rawMessages = await prisma.message.findMany({
        where: { channelId, parentId: null },
        orderBy: { createdAt: 'asc' },
        take: 30,
        include: { _count: { select: { replies: true } } },
      })
      const messages = rawMessages.map(({ _count, ...m }) => ({ ...m, replyCount: _count.replies }))
      socket.emit('history', { channelId, messages })
    })

    socket.on('send_message', async (data: {
      username: string; content: string; channelId: number
      attachmentData?: string; attachmentName?: string; attachmentType?: string
    }) => {
      const channel = await prisma.channel.findUnique({
        where: { id: data.channelId }, include: { members: { select: { username: true } } },
      })
      if (!channel) return
      if (channel.isPrivate && !channel.members.some((m) => m.username === username)) return
      const message = await prisma.message.create({
        data: {
          username: data.username, content: data.content ?? '',
          channelId: data.channelId,
          attachmentData: data.attachmentData ?? null,
          attachmentName: data.attachmentName ?? null,
          attachmentType: data.attachmentType ?? null,
        },
      })
      await emitNewMessage(channel.id, channel.isPrivate, channel.members.map((m) => m.username), { ...message, replyCount: 0 })
    })

    socket.on('create_channel', async ({ name, isPrivate }: { name: string; isPrivate?: boolean }) => {
      try {
        const channel = await prisma.channel.create({ data: { name: name.trim(), isPrivate: isPrivate ?? false } })
        if (isPrivate) await prisma.channelMember.create({ data: { channelId: channel.id, username } })
        await broadcastChannels()
      } catch { socket.emit('channel_error', 'そのチャンネル名はすでに存在します') }
    })

    socket.on('delete_channel', async (id: number) => {
      await prisma.channel.delete({ where: { id } })
      await broadcastChannels()
    })

    socket.on('rename_channel', async ({ id, name }: { id: number; name: string }) => {
      try {
        await prisma.channel.update({ where: { id }, data: { name: name.trim() } })
        await broadcastChannels()
      } catch { socket.emit('channel_error', 'そのチャンネル名はすでに存在します') }
    })

    socket.on('invite_to_channel', async ({ channelId, inviteeUsername }: { channelId: number; inviteeUsername: string }) => {
      const isMember = await prisma.channelMember.findUnique({
        where: { channelId_username: { channelId, username } },
      })
      if (!isMember) return socket.emit('channel_error', 'このチャンネルのメンバーではありません')
      await prisma.channelMember.upsert({
        where:  { channelId_username: { channelId, username: inviteeUsername } },
        update: {},
        create: { channelId, username: inviteeUsername },
      })
      const sockets = await io.fetchSockets()
      const inviteeSocket = sockets.find(
        (s) => (s.handshake.auth as { username?: string }).username === inviteeUsername
      )
      if (inviteeSocket) {
        inviteeSocket.emit('channel_list', await getChannelsForUser(inviteeUsername))
      }
      await broadcastChannels()
      socket.emit('invite_success', inviteeUsername)
    })

    socket.on('edit_message', async ({ messageId, content }: { messageId: number; content: string }) => {
      const trimmed = content.trim(); if (!trimmed) return
      const msg = await prisma.message.findUnique({ where: { id: messageId } })
      if (!msg || msg.username !== username) return
      const updated = await prisma.message.update({ where: { id: messageId }, data: { content: trimmed } })
      const replyCount = await prisma.message.count({ where: { parentId: messageId } })
      io.emit('message_edited', { ...updated, replyCount })
    })

    socket.on('get_thread', async (messageId: number) => {
      const rawParent = await prisma.message.findUnique({
        where: { id: messageId },
        include: { _count: { select: { replies: true } } },
      })
      if (!rawParent) return
      const { _count, ...parent } = rawParent
      const replies = await prisma.message.findMany({
        where: { parentId: messageId },
        orderBy: { createdAt: 'asc' },
      })
      socket.emit('thread_data', {
        parent: { ...parent, replyCount: _count.replies },
        replies: replies.map(r => ({ ...r, replyCount: 0 })),
      })
    })

    socket.on('send_thread_reply', async ({ content, parentId }: { content: string; parentId: number }) => {
      const trimmed = content.trim(); if (!trimmed) return
      const parentMsg = await prisma.message.findUnique({
        where: { id: parentId },
        include: { channel: { include: { members: { select: { username: true } } } } },
      })
      if (!parentMsg) return
      const channel = parentMsg.channel
      if (channel.isPrivate && !channel.members.some((m) => m.username === username)) return
      const reply = await prisma.message.create({
        data: { username, content: trimmed, channelId: parentMsg.channelId, parentId, attachmentData: null, attachmentName: null, attachmentType: null },
      })
      const replyCount = await prisma.message.count({ where: { parentId } })
      const replyPayload = { ...reply, replyCount: 0, parentUsername: parentMsg.username }
      const countPayload = { messageId: parentId, replyCount }
      if (!channel.isPrivate) {
        io.emit('thread_reply', replyPayload)
        io.emit('reply_count_update', countPayload)
      } else {
        const memberSet = new Set(channel.members.map((m) => m.username))
        const sockets = await io.fetchSockets()
        for (const s of sockets) {
          const uname = (s.handshake.auth as { username?: string }).username
          if (uname && memberSet.has(uname)) {
            s.emit('thread_reply', replyPayload)
            s.emit('reply_count_update', countPayload)
          }
        }
      }
    })

    socket.on('delete_message', async ({ messageId }: { messageId: number }) => {
      const msg = await prisma.message.findUnique({ where: { id: messageId } })
      if (!msg || msg.username !== username) return
      await prisma.message.delete({ where: { id: messageId } })
      io.emit('message_deleted', { messageId, channelId: msg.channelId })
    })

    socket.on('update_profile', async () => { await broadcastProfiles() })

    socket.on('update_profile_details', async ({ email, title }: { email?: string; title?: string }) => {
      await prisma.userProfile.upsert({
        where:  { username },
        update: { email: email || null, title: title || null },
        create: { username, avatarUrl: null, email: email || null, title: title || null },
      })
      await broadcastProfiles()
    })
  })

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`)
  })
})
