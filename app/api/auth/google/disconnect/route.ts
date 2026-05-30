import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(request: Request) {
  const { username } = await request.json()
  if (!username) return NextResponse.json({ error: 'Missing username' }, { status: 400 })
  await prisma.userCalendar.deleteMany({ where: { username } })
  return NextResponse.json({ ok: true })
}
