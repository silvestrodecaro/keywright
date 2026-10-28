'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('rfide', {
  // Projects
  recentProjects: () => ipcRenderer.invoke('projects:recent'),
  removeRecentProject: (root) => ipcRenderer.invoke('projects:remove-recent', root),
  detectTools: () => ipcRenderer.invoke('projects:detect-tools'),
  defaultProjectLocation: () => ipcRenderer.invoke('projects:default-location'),
  validateProjectName: (name) => ipcRenderer.invoke('projects:validate-name', name),
  currentProject: () => ipcRenderer.invoke('projects:current'),
  pickFolder: (title) => ipcRenderer.invoke('projects:pick-folder', title),
  openProject: (root) => ipcRenderer.invoke('projects:open', root),
  createProject: (request) => ipcRenderer.invoke('projects:create', request),
  closeProject: () => ipcRenderer.invoke('projects:close'),
  onSetupSteps: (callback) => subscribe('setup:steps', callback),
  onSetupStep: (callback) => subscribe('setup:step', callback),
  onSetupLog: (callback) => subscribe('setup:log', callback),

  // Project files
  projectTree: () => ipcRenderer.invoke('project:tree'),
  readProjectFile: (relative) => ipcRenderer.invoke('project:read-file', relative),
  revealInExplorer: (relative) => ipcRenderer.invoke('project:reveal', relative),
  onFilesChanged: (callback) => subscribe('project:files-changed', callback),
  writeProjectFile: (relative, content) => ipcRenderer.invoke('project:write-file', relative, content),
  createProjectFile: (relative) => ipcRenderer.invoke('project:create-file', relative),
  projectKeywords: () => ipcRenderer.invoke('project:keywords'),
  projectVariables: () => ipcRenderer.invoke('project:variables'),
  searchProject: (options, exclude) => ipcRenderer.invoke('project:search', options, exclude),
  replaceInProject: (options, replacement, entries) => ipcRenderer.invoke('project:replace', options, replacement, entries),
  checkFile: (relative, text) => ipcRenderer.invoke('editor:check', relative, text),
  formatFile: (relative, text) => ipcRenderer.invoke('editor:format', relative, text),
  lintFile: (relative, text) => ipcRenderer.invoke('editor:lint', relative, text),
  installRobocop: () => ipcRenderer.invoke('project:install-robocop'),
  confirmUnsaved: (names) => ipcRenderer.invoke('dialog:unsaved', names),

  // Test runner
  discoverTests: () => ipcRenderer.invoke('tests:discover'),
  runTests: (options) => ipcRenderer.invoke('tests:run', options),
  stopTests: () => ipcRenderer.invoke('tests:stop'),
  debugCommand: (command) => ipcRenderer.invoke('tests:debug-command', command),
  testHistory: () => ipcRenderer.invoke('tests:history'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (callback) => subscribe('update:state', callback),
  onHistoryAdded: (callback) => subscribe('tests:history-added', callback),
  openTestOutput: (file) => ipcRenderer.invoke('tests:open-output', file),
  testOutputUrl: (file) => ipcRenderer.invoke('tests:output-url', file),
  traceUrl: (traceFile) => ipcRenderer.invoke('tests:trace-url', traceFile),
  onTestEvent: (callback) => subscribe('tests:event', callback),
  onTestOutput: (callback) => subscribe('tests:output', callback),
  onTestsFinished: (callback) => subscribe('tests:finished', callback),

  // Test generator
  startRecording: (options) => ipcRenderer.invoke('recorder:start', options),
  installBrowser: (name) => ipcRenderer.invoke('recorder:install-browser', name),
  onInstallLog: (callback) => subscribe('recorder:install-log', callback),
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),
  clearRecording: () => ipcRenderer.invoke('recorder:clear'),
  removeStep: (index) => ipcRenderer.invoke('recorder:remove-step', index),
  setGeneratorOptions: (options) => ipcRenderer.invoke('generator:set-options', options),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  saveFile: (code) => ipcRenderer.invoke('file:save', code),
  onCode: (callback) => subscribe('recorder:code', callback),
  onState: (callback) => subscribe('recorder:state', callback),
  pickLocator: (options) => ipcRenderer.invoke('locator:pick', options),
  cancelPickLocator: () => ipcRenderer.invoke('locator:cancel'),
  onPickState: (callback) => subscribe('locator:state', callback),
});
