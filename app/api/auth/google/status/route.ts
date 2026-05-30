// Handled by custom server in server.ts
export const dynamic = 'force-dynamic'
export async function GET() {
  return new Response('Handled by custom server', { status: 200 })
}
