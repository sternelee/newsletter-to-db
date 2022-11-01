#!/usr/bin/env node

import path from "path";
import { SMTPServer } from "smtp-server";
import mailparser from "mailparser";
import cryptoRandomString from "crypto-random-string";
import { sql, Database } from "@leafac/sqlite";
import databaseMigrate from "@leafac/sqlite-migration";

const VERSION = require("../package.json").version;

const Url = 'smtp://localhost:2525'

function newReference(): string {
  return cryptoRandomString({
    length: 16,
    characters: "abcdefghijklmnopqrstuvwxyz0123456789",
  });
}

const database = new Database(
  path.join(path.join(process.cwd(), "data"), "newsletter.db")
);
databaseMigrate(database, [
  sql`
      CREATE TABLE "feeds" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "reference" TEXT NOT NULL UNIQUE,
        "title" TEXT NOT NULL
      );

      CREATE TABLE "entries" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "reference" TEXT NOT NULL UNIQUE,
        "feed" INTEGER NOT NULL REFERENCES "feeds",
        "title" TEXT NOT NULL,
        "author" TEXT NOT NULL,
        "content" TEXT NOT NULL
      );
    `,
  sql`
      CREATE INDEX "entriesFeed" ON "entries" ("feed");
    `,
]);

const emailApplication = new SMTPServer({
  disabledCommands: ["AUTH", "STARTTLS"],
  async onData(stream, session, callback) {
    try {
      const email = await mailparser.simpleParser(stream);
      const from = email.from?.text ?? "";
      const subject = email.subject ?? "";
      const body =
        typeof email.html === "string" ? email.html : email.textAsHtml ?? "";
      database.executeTransaction(() => {
        for (const address of new Set(
          session.envelope.rcptTo.map(
            (smtpServerAddress) => smtpServerAddress.address
          )
        )) {
          const addressParts = address.split("@");
          if (addressParts.length !== 2) continue;
          const [feedReference, hostname] = addressParts;
          if (hostname !== new URL(Url).hostname) continue;
          const feed = database.get<{ id: number }>(
            sql`SELECT "id" FROM "feeds" WHERE "reference" = ${feedReference}`
          );
          if (feed === undefined) continue;
          database.run(
            sql`
              INSERT INTO "entries" ("reference", "feed", "title", "author", "content")
              VALUES (
                ${newReference()},
                ${feed.id},
                ${subject},
                ${from},
                ${body}
              )
            `
          );
          database.run(
            sql`UPDATE "feeds" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${feed.id}`
          );
        }
      });
      callback();
    } catch (error) {
      console.error(
        `Failed to receive message: ‘${JSON.stringify(session, null, 2)}’`
      );
      console.error(error);
      stream.resume();
      callback(new Error("Failed to receive message. Please try again."));
    }
  },
});

emailApplication.listen(new URL(Url).port, () => {
  console.log(`Email server started at ${Url}`);
});
