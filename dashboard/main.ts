import 'dotenv/config';
import { startDashboard } from './index';

async function main() {
  try {
    const handle = await startDashboard();
    const url =
      handle.host === '0.0.0.0' || handle.host === '::'
        ? `http://localhost:${handle.port}`
        : `http://${handle.host}:${handle.port}`;
    console.log(`\n  📊 AI LB dashboard → ${url}\n`);

    const shutdown = async () => {
      console.log('\nShutting down…');
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
