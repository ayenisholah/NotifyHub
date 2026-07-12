$ErrorActionPreference = 'Stop'
$required = @(
  'README.md', 'CHANGELOG.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md',
  'CODE_OF_CONDUCT.md', 'docs/engineering-specification.md',
  'docs/IMPLEMENTATION_PLAN.md', 'docs/MILESTONES.md', 'docs/DECISIONS.md',
  'docs/PROGRESS.md'
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing required file: $path" }
}
if (-not (Select-String -Quiet -LiteralPath '.gitignore' -Pattern '^sample/$')) {
  throw 'sample/ must be excluded from publication'
}
if (-not (Select-String -Quiet -LiteralPath '.gitignore' -Pattern '^notifyhub-engineering-doc\.md$')) {
  throw 'private source document must be excluded from publication'
}
Write-Host 'Governance verification passed.'
