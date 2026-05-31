-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "channelId" INTEGER NOT NULL,
    "attachmentData" TEXT,
    "attachmentName" TEXT,
    "attachmentType" TEXT,
    "parentId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("attachmentData", "attachmentName", "attachmentType", "channelId", "content", "createdAt", "id", "username") SELECT "attachmentData", "attachmentName", "attachmentType", "channelId", "content", "createdAt", "id", "username" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
