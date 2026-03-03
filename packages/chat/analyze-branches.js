const fs = require('fs')
const coverage = JSON.parse(fs.readFileSync('coverage/coverage-final.json', 'utf8'))

const targets = [
  'src/services/privacy.ts',
  'src/services/moderation.ts',
  'src/services/message.ts',
  'src/services/conversation.ts',
  'src/services/read-state.ts',
  'src/services/event-log.ts',
  'src/views/index.ts',
]

for (const [file, data] of Object.entries(coverage)) {
  const shortPath = file.replace(/.*packages\/chat\//, '')
  if (!targets.some(t => shortPath === t)) continue

  console.log(`\n=== ${shortPath} ===`)

  // Uncovered branches
  const branchMap = data.branchMap || {}
  const branchCounts = data.b || {}
  let uncoveredBranches = []

  for (const [id, info] of Object.entries(branchMap)) {
    const counts = branchCounts[id] || []
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] === 0) {
        const loc = info.locations ? info.locations[i] : info.loc
        const startLine = loc ? loc.start.line : '?'
        const endLine = loc ? loc.end.line : '?'
        uncoveredBranches.push({
          branchId: id,
          index: i,
          type: info.type,
          startLine,
          endLine,
        })
      }
    }
  }

  uncoveredBranches.sort((a, b) => (a.startLine || 0) - (b.startLine || 0))

  if (uncoveredBranches.length === 0) {
    console.log('  All branches covered!')
  } else {
    console.log(`  Uncovered branches (${uncoveredBranches.length}):`)
    for (const ub of uncoveredBranches) {
      console.log(`    Line ${ub.startLine}-${ub.endLine} [${ub.type}] branch#${ub.branchId}[${ub.index}]`)
    }
  }

  // Uncovered statements
  const stmtMap = data.statementMap || {}
  const stmtCounts = data.s || {}
  let uncoveredStmts = []

  for (const [id, loc] of Object.entries(stmtMap)) {
    if (stmtCounts[id] === 0) {
      uncoveredStmts.push({
        stmtId: id,
        startLine: loc.start.line,
        endLine: loc.end.line,
      })
    }
  }

  uncoveredStmts.sort((a, b) => a.startLine - b.startLine)

  if (uncoveredStmts.length > 0) {
    console.log(`  Uncovered statements (${uncoveredStmts.length}):`)
    for (const us of uncoveredStmts) {
      console.log(`    Line ${us.startLine}-${us.endLine} stmt#${us.stmtId}`)
    }
  }

  // Uncovered functions
  const fnMap = data.fnMap || {}
  const fnCounts = data.f || {}
  let uncoveredFns = []

  for (const [id, info] of Object.entries(fnMap)) {
    if (fnCounts[id] === 0) {
      uncoveredFns.push({
        fnId: id,
        name: info.name || '(anonymous)',
        startLine: info.loc ? info.loc.start.line : info.decl ? info.decl.start.line : '?',
      })
    }
  }

  if (uncoveredFns.length > 0) {
    console.log(`  Uncovered functions (${uncoveredFns.length}):`)
    for (const uf of uncoveredFns) {
      console.log(`    Line ${uf.startLine} ${uf.name} fn#${uf.fnId}`)
    }
  }
}
