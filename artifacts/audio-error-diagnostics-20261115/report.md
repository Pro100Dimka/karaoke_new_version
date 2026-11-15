# Automatic audio error diagnostics

Date: 2026-11-15

## Behavior

AudioService command failures, transport failures, stderr and unexpected process exits trigger a read-only GetDiagnostics request from the Electron main process. Renderer error notifications also trigger this request, so collection does not depend on a working renderer.

There are no new diagnostic timers or periodic requests. Successful playback and normal startup do not request a snapshot. Concurrent error callbacks share the in-flight capture. If the service cannot answer, the existing log records that failure instead.

Snapshots include the application version, triggering event and native diagnostic response. The existing uploader redacts the complete text before splitting it into bounded, correlated chunks, and uses its existing bounded queue and retry behavior. The configured upload opt-out remains effective. No recordings or audio samples are uploaded.

## Verification

- Compiled Electron and passed the frontend TypeScript and architecture checks.
- Launched the final development application with CDP on port 9230.
- Sent an intentionally unknown, non-mutating AudioService command through the existing desktop bridge. Its rejected response produced the expected command error and a complete four-part audio snapshot in Oracle's existing program log.
- Reassembled that snapshot on the server. It included version 1.1.38, reason command-failed:DiagnosticUnknownCommand, ServiceState Running, SessionState Running, backend ASIO and playback/preview state 0.
- Emitted an explicitly labeled renderer error marker through CDP. Renderer-error snapshots also arrived through the existing endpoint.
- Updated existing uploader, managed-service logging and IPC cases for chunking/redaction, error snapshots and no snapshot on successful Play. No new test functions or test files were added. Automated test suites were not run.
- Server configuration, routes and database schema were not changed. Read-only SSH inspection confirmed receipt of the client uploads.
- Closed the diagnostic application after verification without starting processing jobs or recordings.
