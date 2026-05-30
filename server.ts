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

const adapter = new PrismaBetterSqlite3({ url: getDbPath() })
const prisma = new PrismaClient({ adapter } as never)

const DEFAULT_CHANNELS = ['general', '経理・事務', 'odori-fit', '潜在美学-yt']

const dev = process.env.NODE_ENV !== 'production'
const port = parseInt(process.env.PORT ?? '3000', 10)
const app = next({ dev, port })
const handle = app.getRequestHandler()

async function seedChannels() {
  const count = await prisma.channel.count()
  if (count === 0) {
    await prisma.channel.createMany({
      data: DEFAULT_CHANNELS.map((name) => ({ name })),
    })
  }
}

app.prepare().then(async () => {
  await seedChannels()

  const httpServer = createServer(handle)
  const io = new Server(httpServer)

  async function broadcastChannels() {
    const channels = await prisma.channel.findMany({ orderBy: { createdAt: 'asc' } })
    io.emit('channel_list', channels)
  }

  async function broadcastProfiles() {
    const profiles = await prisma.userProfile.findMany()
    io.emit('user_profiles', Object.fromEntries(profiles.map((p) => [p.username, p.avatarUrl])))
  }

  io.on('connection', async (socket) => {
    // 接続時: チャンネル一覧・プロフィール・最初のチャンネル履歴を送信
    const channels = await prisma.channel.findMany({ orderBy: { createdAt: 'asc' } })
    socket.emit('channel_list', channels)

    // プロフィール一覧を送信
    const profiles = await prisma.userProfile.findMany()
    socket.emit('user_profiles', Object.fromEntries(profiles.map((p) => [p.username, p.avatarUrl])))

    if (channels.length > 0) {
      const messages = await prisma.message.findMany({
        where: { channelId: channels[0].id },
        orderBy: { createdAt: 'asc' },
        take: 100,
      })
      socket.emit('history', { channelId: channels[0].id, messages })
    }

    // チャンネル切り替え
    socket.on('join_channel', async (channelId: number) => {
      const messages = await prisma.message.findMany({
        where: { channelId },
        orderBy: { createdAt: 'asc' },
        take: 100,
      })
      socket.emit('history', { channelId, messages })
    })

    // メッセージ送信
    socket.on('send_message', async (data: { username: string; content: string; channelId: number }) => {
      const message = await prisma.message.create({
        data: { username: data.username, content: data.content, channelId: data.channelId },
      })
      io.emit('new_message', message)
    })

    // チャンネル作成
    socket.on('create_channel', async (name: string) => {
      try {
        await prisma.channel.create({ data: { name: name.trim() } })
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

    // プロフィール更新（アバターアップロード後にクライアントから通知）
    socket.on('update_profile', async () => {
      await broadcastProfiles()
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
  })

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`)
  })
})
