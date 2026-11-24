import { readFileSync, writeFileSync } from 'node:fs'
const body = readFileSync(new URL('./src/client.js', import.meta.url), 'utf8')
const output = `/* 由 build.mjs 生成；编辑 src/client.js 后运行 node build.mjs */
window.__ModuleLoader__.load({
  id: 'dsh-ddj-go',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React
${body.split('\n').map((line) => (line ? '    ' + line : line)).join('\n')}
  },
})
`
writeFileSync(new URL('./client.js', import.meta.url), output)
console.log('client.js:', output.length, 'bytes')
