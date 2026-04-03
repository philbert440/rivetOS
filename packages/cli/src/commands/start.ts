/**
 * rivetos start [--config <path>]
 */

import { resolve } from 'node:path';

export default async function start(): Promise<void> {
  const args = process.argv.slice(3);
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
      configPath = args[++i];
    }
  }

  if (!configPath) {
    // Default config locations
    const candidates = [
      resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml'),
      resolve(process.env.HOME ?? '.', '.rivetos', 'config.yml'),
      resolve('.', 'config.yaml'),
    ];

    for (const candidate of candidates) {
      try {
        await import('node:fs/promises').then((fs) => fs.access(candidate));
        configPath = candidate;
        break;
      } catch {}
    }
  }

  if (!configPath) {
    console.error('No config found. Run `rivetos config init` or use --config <path>');
    process.exit(1);
  }

  // Import and run boot
  const { boot } = await import('../../../../src/boot.js');
  await boot(configPath);
}
