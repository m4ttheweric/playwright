#!/usr/bin/env node
'use strict';

const path = require('path');
const packageJson = require('./package.json');
const { program } = require(path.join(__dirname, 'playwright-core/lib/utilsBundle'));
const { tools } = require(path.join(__dirname, 'playwright-core/lib/coreBundle'));

const p = program
    .version(packageJson.version)
    .name('Fast Browser MCP');
tools.decorateMCPCommand(p, packageJson.version);
void program.parseAsync(process.argv);
