import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANNELS, type BgtApi, type QueueProgressEvent, type SetupProgress, type Submission, type UpdateState } from '../shared/ipc';

const invoke = <T>(channel: string, arg?: unknown) => ipcRenderer.invoke(channel, arg) as Promise<T>;

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: BgtApi = {
  ping: () => invoke(CHANNELS.ping),
  library: { list: () => invoke(CHANNELS.libraryList) },
  job: {
    get: (jobId) => invoke(CHANNELS.jobGet, jobId),
    openOutputFolder: (jobId) => invoke(CHANNELS.jobOpenOutputFolder, jobId),
    delete: (jobId) => invoke(CHANNELS.jobDelete, jobId),
  },
  queue: {
    list: () => invoke(CHANNELS.queueList),
    submit: (request) => invoke(CHANNELS.queueSubmit, request),
    cancel: (id) => invoke(CHANNELS.queueCancel, id),
    resume: (id) => invoke(CHANNELS.queueResume, id),
    onChanged: (cb) => subscribe<Submission[]>(CHANNELS.queueChanged, cb),
    onProgress: (cb) => subscribe<QueueProgressEvent>(CHANNELS.queueProgress, cb),
  },
  source: {
    probe: (source) => invoke(CHANNELS.sourceProbe, source),
    estimate: (a) => invoke(CHANNELS.sourceEstimate, a),
  },
  dialog: {
    pickMedia: () => invoke(CHANNELS.dialogPickMedia),
    pickGlossary: () => invoke(CHANNELS.dialogPickGlossary),
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  setup: {
    state: () => invoke(CHANNELS.setupState),
    detect: () => invoke(CHANNELS.setupDetect),
    plan: (selection) => invoke(CHANNELS.setupPlan, selection),
    missingFor: (options) => invoke(CHANNELS.setupMissingFor, options),
    start: (selection) => invoke(CHANNELS.setupStart, selection),
    cancel: () => invoke(CHANNELS.setupCancel),
    repair: () => invoke(CHANNELS.setupRepair),
    updateYtDlp: () => invoke(CHANNELS.setupUpdateYtDlp),
    openNotices: () => invoke(CHANNELS.setupOpenNotices),
    onProgress: (cb) => subscribe<SetupProgress>(CHANNELS.setupProgress, cb),
  },
  channels: {
    list: () => invoke(CHANNELS.channelsList),
    add: (input) => invoke(CHANNELS.channelsAdd, input),
    remove: (id) => invoke(CHANNELS.channelsRemove, id),
    refresh: (id) => invoke(CHANNELS.channelsRefresh, id),
    feed: () => invoke(CHANNELS.feedList),
    dismiss: (videoId) => invoke(CHANNELS.feedDismiss, videoId),
    dismissAll: (channelId) => invoke(CHANNELS.feedDismissAll, channelId),
    onChanged: (cb) => subscribe<null>(CHANNELS.channelsChanged, () => cb()),
  },
  updates: {
    state: () => invoke(CHANNELS.updatesState),
    check: () => invoke(CHANNELS.updatesCheck),
    download: () => invoke(CHANNELS.updatesDownload),
    install: () => invoke(CHANNELS.updatesInstall),
    onChanged: (cb) => subscribe<UpdateState>(CHANNELS.updatesChanged, cb),
  },
};

contextBridge.exposeInMainWorld('bgt', api);
