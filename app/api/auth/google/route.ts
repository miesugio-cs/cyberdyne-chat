// Google OAuth routes are handled directly in server.ts (custom HTTP server)
// to avoid Next.js/Webpack build-time static replacement of process.env variables.
// This file exists only so Next.js does not emit a 404 for this path at build time.
export const dynamic = 'force-dynamic'
export async function GET() {
  return new Response('Handled by custom server', { status: 200 })
}
