import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get('username')
  if (!username) return NextResponse.json({ connected: false })
  const cal = await prisma.userCalendar.findUnique({ where: { username } })
  return NextResponse.json({ connected: !!cal })
}
