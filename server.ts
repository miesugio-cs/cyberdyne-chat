import { createServer } from 'http'
import { Server } from 'socket.io'
import next from 'next'
import { PrismaClient } from './app/generated/prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import path from 'path'

function getDbPath(): string {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db'
  const filePath = url.replace(/^file:/, '')
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
}

const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: getDbPath() }) } as never)

const DEFAULT_CHANNELS = ['general', '経理・事務', 'odori-fit', '潜在美学-yt']

const dev = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT ?? '3000', 10)
const app = next({ dev, port })
const handle = app.getRequestHandler()

async function seedChannels() {
  const count = await prisma.channel.count()
  if (count === 0) {
    await prisma.channel.createMany({ data: DEFAULT_CHANNELS.map((name) => ({ name })) })
  }
}

// ユーザーが見られるチャンネル一覧（パブリック + 招待済みプライベート）
async function getChannelsForUser(username: string) {
  const channels = await prisma.channel.findMany({
    orderBy: { createdAt: 'asc' },
    include: { members: { select: { username: true } } },
  })
  return channels.filter((ch) => !ch.isPrivate || ch.members.some((m) => m.username === username))
}

app.prepare().then(async () => {
  await seedChannels()

  const httpServer = createServer(handle)
  const io = new Server(httpServer)

  // 各ソケットにパーソナライズされたチャンネル一覧を送信
  async function broadcastChannels() {
    const allChannels = await prisma.channel.findMany({
      orderBy: { createdAt: 'asc' },
      include: { members: { select: { username: true } } },
    })
    const sockets = await io.fetchSockets()
    for (const s of sockets) {
      const uname = (s.handshake.auth as { username?: string }).username
      if (!uname) continue
      const userChannels = allChannels.filter(
        (ch) => !ch.isPrivate || ch.members.some((m) => m.username === uname)
      )
      s.emit('channel_list', userChannels)
    }
  }

  async function broadcastProfiles() {
    const profiles = await prisma.userProfile.findMany()
    io.emit('user_profiles', Object.fromEntries(profiles.map((p) => [p.username, p.avatarUrl])))
  }

  // プライベートチャンネルはメンバーのみに、パブリックは全員に送信
  async function emitNewMessage(channelId: number, isPrivate: boolean, memberUsernames: string[], message: object) {
    if (!isPrivate) {
      io.emit('new_message', message)
    } else {
      const memberSet = new Set(memberUsernames)
      const sockets = await io.fetchSockets()
      for (const s of sockets) {
        const uname = (s.handshake.auth as { username?: string }).username
        if (uname && memberSet.has(uname)) s.emit('new_message', message)
      }
    }
  }

  io.on('connection', async (socket) => {
    const username = (socket.handshake.auth as { username?: string }).username ?? ''

    // 初回: チャンネル一覧・プロフィール・最初のチャンネル履歴
    const channels = await getChannelsForUser(username)
    socket.emit('channel_list', channels)

    const profiles = await prisma.userProfile.findMany()
    socket.emit('user_profiles', Object.fromEntries(profiles.map((p) => [p.username, p.avatarUrl])))

    if (channels.length > 0) {
      const messages = await prisma.message.findMany({
        where: { channelId: channels[0].id },
        orderBy: { createdAt: 'asc' },
        take: 30,
      })
      socket.emit('history', { channelId: channels[0].id, messages })
    }

    // チャンネル切り替え
    socket.on('join_channel', async (channelId: number) => {
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        include: { members: { select: { username: true } } },
      })
      if (!channel) return
      if (channel.isPrivate && !channel.members.some((m) => m.username === username)) return

      const messages = await prisma.message.findMany({
        where: { channelId },
        orderBy: { createdAt: 'asc' },
        take: 30,
      })
      socket.emit('history', { channelId, messages })
    })

    // メッセージ送信（添付ファイル対応）
    socket.on('send_message', async (data: {
      username: string; content: string; channelId: number
      attachmentData?: string; attachmentName?: string; attachmentType?: string
    }) => {
      const channel = await prisma.channel.findUnique({
        where: { id: data.channelId },
        include: { members: { select: { username: true } } },
      })
      if (!channel) return
      if (channel.isPrivate && !channel.members.some((m) => m.username === username)) return

      const message = await prisma.message.create({
        data: {
          username: data.username,
          content: data.content ?? '',
          channelId: data.channelId,
          attachmentData: data.attachmentData ?? null,
          attachmentName: data.attachmentName ?? null,
          attachmentType: data.attachmentType ?? null,
        },
      })
      await emitNewMessage(
        channel.id,
        channel.isPrivate,
        channel.members.map((m) => m.username),
        message,
      )
    })

    // チャンネル作成
    socket.on('create_channel', async ({ name, isPrivate }: { name: string; isPrivate?: boolean }) => {
      try {
        const channel = await prisma.channel.create({ data: { name: name.trim(), isPrivate: isPrivate ?? false } })
        if (isPrivate) {
          await prisma.channelMember.create({ data: { channelId: channel.id, username } })
        }
        await broadcastChannels()
      } catch {
        socket.emit('channel_error', 'そのチャンネル名はすでに存在します')
      }
    })

    // チャンネル削除
    socket.on('delete_channel', async (id: number) => {
      await prisma.channel.delete({ where: { id } })
      await broadcastChannels()
    })

    // チャンネル名変更
    socket.on('rename_channel', async ({ id, name }: { id: number; name: string }) => {
      try {
        await prisma.channel.update({ where: { id }, data: { name: name.trim() } })
        await broadcastChannels()
      } catch {
        socket.emit('channel_error', 'そのチャンネル名はすでに存在します')
      }
    })

    // プライベートチャンネルへの招待
    socket.on('invite_to_channel', async ({ channelId, inviteeUsername }: { channelId: number; inviteeUsername: string }) => {
      const isMember = await prisma.channelMember.findUnique({
        where: { channelId_username: { channelId, username } },
      })
      if (!isMember) return socket.emit('channel_error', 'このチャンネルのメンバーではありません')

      await prisma.channelMember.upsert({
        where: { channelId_username: { channelId, username: inviteeUsername } },
        update: {},
        create: { channelId, username: inviteeUsername },
      })

      // 招待されたユーザーのソケットにチャンネル一覧を送信
      const sockets = await io.fetchSockets()
      const inviteeSocket = sockets.find(
        (s) => (s.handshake.auth as { username?: string }).username === inviteeUsername
      )
      if (inviteeSocket) {
        const inviteeChannels = await getChannelsForUser(inviteeUsername)
        inviteeSocket.emit('channel_list', inviteeChannels)
      }

      await broadcastChannels()
      socket.emit('invite_success', inviteeUsername)
    })

    // アバターアップロード後にプロフィールを全員に配信
    socket.on('update_profile', async () => {
      await broadcastProfiles()
    })
  })

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`)
  })
})
