import { NextRequest, NextResponse } from 'next/server'

// ビルド時静的解析を防ぎ、リクエスト時に process.env を評価させる
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // ドット記法はWebpackが静的置換するため、ブラケット記法で回避
  const clientId     = process.env['GOOGLE_CLIENT_ID']
  const redirectUri  = process.env['GOOGLE_REDIRECT_URI']

  if (!clientId || !redirectUri) {
    const missing = (['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const)
      .filter(k => !process.env[k])
    console.error('[Google Auth] Missing env vars:', missing.join(', '))
    return NextResponse.json(
      { error: `Google Calendar not configured. Missing: ${missing.join(', ')}` },
      { status: 503 },
    )
  }

  const username = request.nextUrl.searchParams.get('username')
  if (!username) return NextResponse.json({ error: 'Missing username' }, { status: 400 })

  const state = Buffer.from(JSON.stringify({ username })).toString('base64url')

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id',     clientId)
  authUrl.searchParams.set('redirect_uri',  redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope',         'https://www.googleapis.com/auth/calendar.readonly')
  authUrl.searchParams.set('access_type',   'offline')
  authUrl.searchParams.set('prompt',        'consent')
  authUrl.searchParams.set('state',         state)

  return NextResponse.redirect(authUrl.toString())
}
