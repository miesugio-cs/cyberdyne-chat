import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// base64 data URL として受け取り DB に保存する（ファイルシステム不使用）
export async function POST(request: Request) {
  const body = await request.json()
  const { username, imageData } = body as { username?: string; imageData?: string }

  if (!username || !imageData) {
    return NextResponse.json({ error: 'Missing data' }, { status: 400 })
  }
  if (!imageData.startsWith('data:image/')) {
    return NextResponse.json({ error: '画像データが不正です' }, { status: 400 })
  }
  // 128x128 JPEG@85% は通常 7〜20KB → base64 で ~27KB 以内
  if (imageData.length > 200_000) {
    return NextResponse.json({ error: '画像データが大きすぎます' }, { status: 400 })
  }

  await prisma.userProfile.upsert({
    where: { username },
    update: { avatarUrl: imageData },
    create: { username, avatarUrl: imageData },
  })

  return NextResponse.json({ avatarUrl: imageData })
}
