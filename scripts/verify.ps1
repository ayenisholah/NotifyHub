$ErrorActionPreference = 'Stop'
$required = @(
  'README.md', 'CHANGELOG.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md',
  'CODE_OF_CONDUCT.md', 'docs/notifyhub-engineering-doc.md',
  'docs/IMPLEMENTATION_PLAN.md', 'docs/MILESTONES.md', 'docs/DECISIONS.md',
  'docs/PROGRESS.md'
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required file: $path" }
}
if (-not (Select-String -Quiet -LiteralPath '.gitignore' -Pattern '^sample/$')) {
  throw 'sample/ must be excluded from publication'
}
Write-Host 'Governance verification passed.'
if (Test-Path -LiteralPath 'package.json') {
  npm.cmd run verify
  if ($LASTEXITCODE -ne 0) { throw "npm verification failed with exit code $LASTEXITCODE" }
}
