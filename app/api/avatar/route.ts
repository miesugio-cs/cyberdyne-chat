import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(request: Request) {
  const formData = await request.formData()
  const file = formData.get('avatar') as File | null
  const username = formData.get('username') as string | null

  if (!file || !username) {
    return NextResponse.json({ error: 'Missing file or username' }, { status: 400 })
  }
  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: '画像ファイルを選択してください' }, { status: 400 })
  }
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: 'ファイルサイズは5MB以下にしてください' }, { status: 400 })
  }

  const ext = file.type.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')
  const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_')
  const filename = `${safeUsername}_${Date.now()}.${ext}`
  const avatarDir = path.join(process.cwd(), 'public', 'avatars')

  await mkdir(avatarDir, { recursive: true })
  await writeFile(path.join(avatarDir, filename), Buffer.from(await file.arrayBuffer()))

  const avatarUrl = `/avatars/${filename}`

  await prisma.userProfile.upsert({
    where: { username },
    update: { avatarUrl },
    create: { username, avatarUrl },
  })

  return NextResponse.json({ avatarUrl })
}
