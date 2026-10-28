'use strict';

// Files written into a newly created Robot Framework project.

const CONFIG_FILE = 'rfide.json';

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
      '## Setup',
      '',
      '```sh',
      'python -m venv .venv',
      '.venv/Scripts/python -m pip install -r requirements.txt   # .venv/bin/python on Linux/macOS',
      '.venv/Scripts/rfbrowser init',
      '```',
      '',
      '## Run',
      '',
      '```sh',
      '.venv/Scripts/robot --outputdir results tests',
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
