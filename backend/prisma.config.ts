import "dotenv/config";
import { defineConfig } from "prisma/config";

// DATABASE_URL is read lazily so `prisma generate` works without a database.
// Locally (outside docker) export DATABASE_URL, or the POSTGRES_* variables
// used by docker-compose, e.g.:
//   DATABASE_URL=postgresql://clearsight:clearsight@localhost:5432/clearsight
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://clearsight:clearsight@localhost:5432/clearsight";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: { url: databaseUrl },
});
