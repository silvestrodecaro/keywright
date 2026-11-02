'use strict';

// Files written into a newly created Robot Framework project.

const CONFIG_FILE = 'keywright.json';

const DEFAULT_CONFIG = {
  version: 1,
  testsDir: 'tests',
  resourcesDir: 'resources',
  outputDir: 'results',
  // Relative to the project root; resolved per platform when null.
  python: null,
};

/**
 * @param {string} name project (folder) name
 * @returns {Record<string, string>} relative path -> file content
 */
function projectFiles(name) {
  return {
    [CONFIG_FILE]: JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
    'requirements.txt': 'robotframework\nrobotframework-browser\nrobotframework-robocop\n',
    '.gitignore': [
      '.venv/',
      'results/',
      '__pycache__/',
      '*.pyc',
      'log.html',
      'report.html',
      'output.xml',
      '',
    ].join('\n'),
    'README.md': [
      `# ${name}`,
      '',
      'Robot Framework tests using the [Browser library](https://robotframework-browser.org).',
      '',
      '## Run in Keywright',
      '',
      'Open this folder in Keywright with **Open folder…**, then choose **Testing → Run all**.',
      'The example suite has one test. It opens `https://example.com` and needs network access.',
      '',
      'If the project wizard completed Python and browser setup, the environment is ready.',
      'Use the manual steps below only when you need to prepare it yourself.',
      '',
      '## Manual environment setup',
      '',
      'For the recommended Python and Node.js versions, see the',
      '[Keywright setup guide](https://github.com/silvestrodecaro/keywright#run-from-source).',
      'Open PowerShell in this project folder. Create `.venv` if it does not already exist,',
      'then install the project dependencies and Chromium:',
      '',
      '```powershell',
      'py -3.13 -m venv .venv',
      '.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt',
      '.\\.venv\\Scripts\\python.exe -m Browser.entry init chromium',
      '```',
      '',
      'These commands use the environment directly; activation is unnecessary.',
      'If the tests use Firefox or WebKit, initialize those browsers as well.',
      '',
      '## Run from PowerShell',
      '',
      'From this project folder:',
      '',
      '```powershell',
      '.\\.venv\\Scripts\\python.exe -m robot --outputdir results tests',
      '```',
      '',
    ].join('\n'),
    'resources/common.resource': [
      '*** Settings ***',
      'Documentation    Keywords and variables shared by the test suites.',
      'Library    Browser',
      '',
      '',
      '*** Variables ***',
      '${BROWSER}     chromium',
      '${HEADLESS}    True',
      '',
      '',
      '*** Keywords ***',
      'Open Test Browser',
      '    [Documentation]    Opens ${BROWSER} (headless unless HEADLESS is False) with a new context.',
      '    New Browser    ${BROWSER}    headless=${HEADLESS}',
      '    New Context',
      '',
    ].join('\n'),
    'tests/example.robot': [
      '*** Settings ***',
      'Documentation     An example test using the Browser library.',
      'Resource          ../resources/common.resource',
      'Suite Setup       Open Test Browser',
      'Suite Teardown    Close Browser    ALL',
      '',
      '',
      '*** Test Cases ***',
      'Example Domain Has Expected Title',
      '    [Documentation]    The page title of example.com is checked.',
      '    New Page    https://example.com',
      '    Get Title    ==    Example Domain',
      '',
    ].join('\n'),
  };
}

module.exports = { projectFiles, CONFIG_FILE, DEFAULT_CONFIG };
