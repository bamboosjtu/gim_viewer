param([Parameter(Mandatory=$true)][string]$Plan)
# The former writable-plan launcher is deliberately unavailable. A replacement
# must authenticate its controller and pin protected build/workspace identities.
# Reject before reading any plan-controlled path or invoking WPR.
throw 'authenticated-system-helper-required'
