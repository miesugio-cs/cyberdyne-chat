import { PrismaClient } from '@/app/generated/prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import path from 'path'

function getDbPath(): string {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db'
  const filePath = url.replace(/^file:/, '')
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: getDbPath() }) } as never)

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
