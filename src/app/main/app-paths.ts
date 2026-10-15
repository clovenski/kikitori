import path from 'node:path';

export interface AppPathsInput {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
  appData: string;
  documents: string;
  env: Record<string, string | undefined>;
}

export interface AppPaths {
  /** Where `tools.lock.json` lives. */
  projectRoot: string;
  /** Downloaded tools and models. */
  resourcesDir: string;
  /** Database, settings, work files. */
  dataDir: string;
  /** Subtitles and summaries. */
  outDir: string;
  /** Electron's userData folder to use, or null to keep the default. */
  userData: string | null;
}

export function resolveAppPaths(a: AppPathsInput): AppPaths {
  const { env } = a;
  const profile = env.KTR_USER_DATA ?? (a.packaged ? path.join(a.appData, 'Kikitori') : null);
  const base = profile ?? a.appPath;
  return {
    projectRoot: env.KTR_PROJECT_ROOT ?? (a.packaged ? a.resourcesPath : a.appPath),
    resourcesDir: env.KTR_RESOURCES_DIR ?? path.join(base, 'resources'),
    dataDir: env.KTR_DATA_DIR ?? path.join(base, 'data'),
    outDir:
      env.KTR_OUTPUT_DIR ??
      (a.packaged && !env.KTR_USER_DATA ? path.join(a.documents, 'Kikitori') : path.join(base, 'output')),
    userData: profile,
  };
}
