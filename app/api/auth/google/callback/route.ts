import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const clientId     = process.env['GOOGLE_CLIENT_ID']
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET']
  const redirectUri  = process.env['GOOGLE_REDIRECT_URI']

  const code  = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  const error = request.nextUrl.searchParams.get('error')

  const home = new URL('/', request.url)
  if (error || !code || !state || !clientId || !clientSecret || !redirectUri) {
    home.searchParams.set('calendar_error', '1')
    return NextResponse.redirect(home)
  }

  let username: string
  try {
    username = JSON.parse(Buffer.from(state, 'base64url').toString()).username
    if (!username) throw new Error()
  } catch {
    home.searchParams.set('calendar_error', '1')
    return NextResponse.redirect(home)
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  })

  if (!tokenRes.ok) {
    home.searchParams.set('calendar_error', '1')
    return NextResponse.redirect(home)
  }

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

  home.searchParams.set('calendar_connected', '1')
  return NextResponse.redirect(home)
}
