import { buildApp } from "./app.js";
import { env } from "./config/env.js";
async function main() {
    const app = await buildApp();
    try {
        const address = await app.listen({
            port: env.PORT,
            host: env.PORT === 8000 ? "0.0.0.0" : env.HOST,
        });
        console.log(`Clearsight Backend listening at ${address}`);
        console.log(`Swagger OpenAPI docs available at ${address}/docs`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=server.js.map