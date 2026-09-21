# Specification implementation map

Все 235 numbered sections из `greenfield-spec.md` отслеживаются этой таблицей.
Колонка `Subsystem` указывает ownership, а `Primary evidence` — основной тестовый блок. Один тестовый файл может подтверждать несколько связанных invariants.

| # | Requirement | Subsystem | Primary evidence |
|---:|---|---|---|
| 1 | Назначение | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 2 | Системная граница | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 3 | Python никогда не реализует | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 4 | Основные Python capabilities | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 5 | Runtime | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 6 | Greenfield структура | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 7 | Dependency direction | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 8 | API layer | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 9 | Persistence layer | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 10 | Backend lifecycle | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 11 | Startup | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 12 | Single backend ownership | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 13 | Health endpoints | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 14 | Degraded mode | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 15 | Capabilities | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 16 | API version | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 17 | Event delivery | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 18 | Reconnect | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 19 | Request identity | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 20 | Idempotency | `system/api/bootstrap` | `tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 21 | Song Library | `songs` | `tests/test_songs_api.py` |
| 22 | Song identity | `songs` | `tests/test_songs_api.py` |
| 23 | Song entity | `songs` | `tests/test_songs_api.py` |
| 24 | Song status | `songs` | `tests/test_songs_api.py` |
| 25 | Source-file policy | `songs` | `tests/test_songs_api.py` |
| 26 | Source identity | `songs` | `tests/test_songs_api.py` |
| 27 | Import Song | `songs` | `tests/test_songs_api.py` |
| 28 | Import atomicity | `songs` | `tests/test_songs_api.py` |
| 29 | Duplicate Detection | `songs` | `tests/test_songs_api.py` |
| 30 | Duplicate result | `songs` | `tests/test_songs_api.py` |
| 31 | Metadata | `songs` | `tests/test_songs_api.py` |
| 32 | Metadata provenance | `songs` | `tests/test_songs_api.py` |
| 33 | User override | `songs` | `tests/test_songs_api.py` |
| 34 | Language | `songs` | `tests/test_songs_api.py` |
| 35 | Language influence | `songs` | `tests/test_songs_api.py` |
| 36 | Cover lifecycle | `songs` | `tests/test_songs_api.py` |
| 37 | Song Project | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 38 | Project artifacts | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 39 | Manifest | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 40 | Artifact categories | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 41 | Никаких filename fallbacks | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 42 | Project revision | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 43 | projectFormatVersion | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 44 | Project compatibility | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 45 | Project migration | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 46 | Migration failure | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 47 | lyricsSync.json | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 48 | lyricsSync content | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 49 | Note invariants | `projects/lyrics` | `tests/test_editor_revisions.py; tests/test_ffmpeg_serialization.py` |
| 50 | Offline Processing | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 51 | Processing modes | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 52 | Pipeline | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 53 | Pipeline parallelism | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 54 | ProcessingJob | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 55 | Job states | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 56 | Job Manager | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 57 | Processing Queue | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 58 | Resource budget | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 59 | AudioService coexistence | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 60 | CPU budget | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 61 | GPU budget | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 62 | Model unload | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 63 | Cancellation | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 64 | Subprocess ownership | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 65 | Watchdogs | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 66 | Crash resume semantics | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 67 | Processing cache | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 68 | Stale cache | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 69 | Processing provenance | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 70 | Progress | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 71 | Processing report | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 72 | Atomic publication | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 73 | Failed processing | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 74 | Full Reprocess | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 75 | Melody Reprocess | `processing/projects` | `tests/test_processing_e2e.py; tests/test_resource_scheduler.py` |
| 76 | Lyrics Discovery | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 77 | Lyrics Provider | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 78 | Offline mode | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 79 | Online provider failure | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 80 | Lyrics identity | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 81 | ASR | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 82 | AI Provider model | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 83 | Capabilities AI provider | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 84 | Required model preflight | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 85 | Forced Alignment | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 86 | Word output | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 87 | Voiced interval refinement | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 88 | Pitch Analysis | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 89 | Pitch Stabilization | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 90 | Note construction | `lyrics/ai/processing` | `tests/test_retry_policy.py; tests/test_processing_e2e.py` |
| 91 | Melody Editor | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 92 | Editor document | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 93 | Editor Save | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 94 | RevisionConflict | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 95 | Editor autosave | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 96 | Editor Reset | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 97 | AI baseline | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 98 | Lyrics mutation | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 99 | Project Validation | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 100 | Validation on read | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 101 | External filesystem mutation | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 102 | Library reconciliation | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 103 | Reconciliation не чинит данные наугад | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 104 | Project repair | `editor/projects/recovery` | `tests/test_editor_revisions.py; tests/test_project_migration_recovery.py` |
| 105 | Song Packages | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 106 | Package Manifest | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 107 | Package compatibility | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 108 | Package Export | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 109 | Package Import | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 110 | Package security | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 111 | Import conflicts | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 112 | SameRevision | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 113 | OlderRevision | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 114 | NewerRevision | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 115 | DivergentRevision | `packages` | `tests/test_package_security.py; tests/test_packages_e2e.py` |
| 116 | Recording boundary | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 117 | RecordingResult | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 118 | Recording storage ownership | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 119 | Register Recording | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 120 | RegisterRecording idempotency | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 121 | Orphan recording recovery | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 122 | Recording reconciliation | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 123 | Recording Library | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 124 | Recording deletion | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 125 | Song deletion | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 126 | Offline Recording Analysis | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 127 | Analysis input | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 128 | Input compatibility | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 129 | Analysis result | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 130 | Analysis version | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 131 | Analysis states | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 132 | Stale Analysis | `recordings/analysis` | `tests/test_recordings_analysis.py; tests/test_recording_startup_recovery.py` |
| 133 | AI Model Registry | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 134 | Model purposes | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 135 | Model states | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 136 | Model download | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 137 | Model disk preflight | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 138 | Partial models | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 139 | Model update | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 140 | Compute mode | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 141 | Compute diagnostics | `models/ai/diagnostics` | `tests/test_models.py; tests/test_system_api.py` |
| 142 | Storage | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 143 | Storage roots | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 144 | Storage path changes | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 145 | Conflict examples | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 146 | Disk Usage | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 147 | Large operation preflight | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 148 | Cache | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 149 | Cache cleanup | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 150 | Cache bounded | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 151 | Temp cleanup | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 152 | Database | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 153 | Core entities | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 154 | DB migrations | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 155 | DB migration failure | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 156 | Settings schema | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 157 | Filesystem + DB transaction | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 158 | Quarantine delete | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 159 | Crash recovery | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 160 | Recovery journal | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 161 | Startup recovery | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 162 | SQLite corruption | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 163 | Backups | `storage/infrastructure/recovery` | `tests/test_transaction_recovery.py; tests/test_migrations_lifecycle.py` |
| 164 | Persistent Settings | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 165 | Audio settings | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 166 | History | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 167 | History examples | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 168 | History pagination | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 169 | Recording pagination | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 170 | Job pagination | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 171 | Logs pagination | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 172 | Large Library | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 173 | List contract | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 174 | Search | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 175 | Search normalization | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 176 | Deterministic sort | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 177 | Logs | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 178 | Log privacy | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 179 | Diagnostics | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 180 | Backend diagnostics | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 181 | AI diagnostics | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 182 | Processing diagnostics | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 183 | Storage diagnostics | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 184 | Recovery diagnostics | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 185 | Version diagnostics | `settings/history/diagnostics` | `tests/test_history_settings.py; tests/test_cache_logging_imports.py` |
| 186 | Room Control | `room` | `tests/test_rooms.py` |
| 187 | Room owns | `room` | `tests/test_rooms.py` |
| 188 | Room does not own | `room` | `tests/test_rooms.py` |
| 189 | Participant | `room` | `tests/test_rooms.py` |
| 190 | Readiness | `room` | `tests/test_rooms.py` |
| 191 | Host authority | `room` | `tests/test_rooms.py` |
| 192 | Room revision | `room` | `tests/test_rooms.py` |
| 193 | Project transfer | `room` | `tests/test_rooms.py` |
| 194 | Host disconnect | `room` | `tests/test_rooms.py` |
| 195 | Concurrency | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 196 | Per-Song Content Lock | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 197 | Delete conflict | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 198 | Reprocess conflict | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 199 | Global lock | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 200 | Background Jobs | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 201 | Job types | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 202 | Domain-specific behavior | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 203 | External network dependency | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 204 | Offline mode | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 205 | Network-only capabilities | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 206 | Native offline helpers | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 207 | Native candidates | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 208 | Не переносить application backend в C++ | `processing/projects/jobs` | `tests/test_executor_process_paths.py; tests/test_resource_scheduler.py` |
| 209 | FFmpeg | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 210 | Security | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 211 | Validation | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 212 | Paths | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 213 | Atomic writes | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 214 | Encoding | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 215 | Persistent timestamps | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 216 | Error contract | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 217 | Error examples | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 218 | No tracebacks in normal API | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 219 | Graceful shutdown | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 220 | Stopping state | `infrastructure/api/bootstrap` | `tests/test_ffmpeg_serialization.py; tests/test_system_api.py; tests/test_migrations_lifecycle.py` |
| 221 | Main Song Flow | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 222 | Editor Flow | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 223 | Recording Flow | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 224 | Recording Failure Recovery | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 225 | Analysis Flow | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 226 | Room Flow | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 227 | Главный architecture invariant | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 228 | Python может работать параллельно | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 229 | Основная цель архитектуры | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 230 | Definition of Done для Python capability | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 231 | Запрещённые архитектурные формы | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 232 | Правило размера ответственности | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 233 | Финальная граница | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 234 | Итоговый принцип | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |
| 235 | Specification state | `cross-feature flows/architecture` | `tests/test_architecture.py; integration/E2E suite` |

Tracked sections: **235 / 235**.
