$ErrorActionPreference = 'Stop'
npm.cmd run test:kill
if ($LASTEXITCODE -ne 0) { throw "Reliability test failed with exit code $LASTEXITCODE" }
