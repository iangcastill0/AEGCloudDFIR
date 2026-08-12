import { loadConfig, type AppConfig } from '@aeg-clouddfir/config';

let cached: AppConfig | undefined;

/** Load and validate the environment exactly once per process. */
export function getAppConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
