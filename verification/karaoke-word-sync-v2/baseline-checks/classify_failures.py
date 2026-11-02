"""Classify observed baseline failures from saved logs and read-only source inspection.

No reruns, skips, source edits or test-expectation changes. An immediate exception is not
necessarily a proven underlying product root cause; unknown causes remain explicit.
"""
from pathlib import Path
import json,re
from collections import Counter
ROOT=Path('/tmp/karaoke-sync-v2/baseline-checks')
BASE=Path('/workspace/scratch/513dbcd967bf/baseline-v1/karaoke_new_version-refactor-frontend-direct')
blocks=json.loads((ROOT/'failure-blocks.json').read_text())
ids=(ROOT/'failure-ids.txt').read_text().splitlines()
historical=json.loads((ROOT/'historical-v1-comparison.json').read_text())

def classify(n):
    if n.startswith('test_locked_architecture'):
        return 'architecture_debt','Architecture checker returns60 violations, beginning with ctc.py 718 lines versus 500 limit.','Confirmed checker result; individual architectural causes are in architecture.log.',['python/scripts/architecture_check.py','python/tests/test_architecture.py']
    if n.startswith('test_local_alignment_reuses_only_unchanged_recognition'):
        return 'recognition_payload_contract','Alignment runner input has an additional alternatives field; test requires equality to the original recognition object.','Confirmed payload/test contract mismatch; not an audio boundary inference or hardware failure.',['python/tests/test_command_ai_provider.py','python/backend/infrastructure/command_ai_provider.py']
    if n.startswith('test_speech_weights_are_cast_before_cuda'):
        return 'cuda_embedding_dtype','CUDA code path calls half() on Embedding; assertion requires float32 but receives float16.','Confirmed implementation/test mismatch. The test mocks model.to, so no actual CUDA hardware is needed; absence of GPU does not explain this failure.',['python/backend/ai_worker/speech.py','python/tests/test_letter_alignment.py']
    if n.startswith('test_a_recognized_word_overlapping'):
        return 'targeted_word_alignment','Natural cached uncertain case places один at 9.94 s instead of the existing <9.5 s regression bound.','Confirmed targeted timing failure. Separate Odin/acoustic reports analyze underlying token borrowing and independent anchors.',['python/tests/test_letter_alignment.py','python/backend/ai_worker/word_guidance.py']
    if n.startswith('test_library_publication_failure'):
        return 'library_api_contract','Test accesses SqlLibraryStorage._publish, which is absent.','Confirmed missing API/test hook; rollback behavior is not reached by this test.',['python/tests/test_library_archive.py','python/backend/infrastructure/library_archive.py']
    if n.startswith('test_exported_repetitive_audio'):
        return 'asynchronous_job_timeout','wait_for_job exhausts its 10 s event wait while preparing the song, before the compression-policy assertion.','Immediate timeout confirmed; exact background job state/root cause absent from saved traceback. This outcome differs from the historical run; do not call it a new alignment regression or assume harmless flakiness.',['python/tests/test_packages_e2e.py','python/tests/helpers.py']
    if n.startswith('test_line_process_kills'):
        return 'process_pipe_contract','read_line raises RuntimeError for closed native control pipe; test expects empty string.','Confirmed API behavior mismatch after process termination.',['python/backend/infrastructure/process_runner.py','python/tests/test_process_ownership.py']
    if n.startswith('test_clip_download_overlaps'):
        return 'clip_publication_behavior','Song videoUrl remains the YouTube URL instead of the expected local /songs/<id>/clip URL.','Observed publication mismatch; full root cause not established from this assertion alone.',['python/tests/test_processing_e2e.py','python/backend/songs/prepare_clip.py']
    if n.startswith('test_cancelling_processing'):
        return 'clip_cancellation_contract','Clip-stopped event is not set when job resources are released. True variant also records an assertion that cancellation Event objects differ.','Immediate failures confirmed. Product uses a separate clip cancellation flow; whether test or behavior should change requires a separate contract review.',['python/tests/test_processing_e2e.py','python/backend/songs/prepare_clip.py']
    if n.startswith('test_cuda_alignment_with_catalog'):
        return 'prepared_audio_test_fixture','The test PreparedAudio substitute is SimpleNamespace without music; document_pipeline.run reads prepared.music.bpm.','Confirmed incomplete test fixture at the reporting boundary. Failure is not CUDA execution or real-device unavailability.',['python/tests/test_processing_execution.py','python/backend/processing/document_pipeline.py']
    if n.startswith('test_every_ai_stage_receives'):
        return 'resource_probe_test_fixture','Job fails InsufficientRam before AI stages: test probe reports availableRAM16 GiB but totalRAM16000 bytes; default minimum free RAM is 512 MiB.','Confirmed contradictory fixture. Scheduler total-RAM guard rejects both CPU/CUDA cases regardless of actual machine RAM/GPU.',['python/tests/test_resource_scheduler.py','python/tests/test_processing_execution.py','python/backend/processing/policies.py','python/backend/processing/resource_scheduler.py']
    if n.startswith('test_empty_cleanup_preserves'):
        return 'recording_cleanup_behavior','Deleting an empty take with recording-recovery.json returns 204; test expects 409 and retained files.','Observed deletion/recovery-descriptor contract mismatch; exact intended retention behavior not adjudicated.',['python/tests/test_recording_empty_cleanup.py','python/backend/recordings/delete.py']
    if n.startswith(('test_startup_recovers_finalized','test_recording_api_reports_actual')):
        return 'recording_startup_behavior','Recording lookup returns 404 RecordingNotFound after preparing a recovery descriptor; test expects recovered recording 200.','Observed startup recovery failure; detailed cause not determined by the saved response alone.',['python/tests/test_recording_startup_recovery.py']
    if n.startswith('test_new_performance_is_balanced'):
        return 'recording_capture_contract','Expected recording.original.wav does not exist after registration.','Confirmed missing expected preservation artifact; registration/mastering lifecycle requires separate review.',['python/tests/test_recordings_analysis.py','python/backend/recordings/studio_master.py']
    if n.startswith(('test_analysis_uses_separated','test_old_analysis_algorithm','test_an_analysis_that_crashes','test_cancelled_analysis_does_not_publish')):
        return 'recording_analysis_submission','Analysis POST response lacks jobId; test raises KeyError before reaching the intended processing/cancellation assertion.','Immediate API failure confirmed. Saved traceback omits response status/body, so precise cause is unresolved; do not invent a CUDA or alignment cause.',['python/tests/test_recordings_analysis.py','python/tests/test_release_regressions.py']
    if n.startswith('test_delete_recording_removes'):
        return 'recording_delete_conflict','Delete returns 409 Conflict instead of expected 204.','Observed conflict; response body and active-job state not printed, so exact cause remains unresolved.',['python/tests/test_recordings_analysis.py']
    if n.startswith('test_rejected_analysis_submission'):
        return 'recording_analysis_registry','POST returned 409 as expected, but analysis registry is empty, causing IndexError at json()[0].','Immediate registry mismatch confirmed; failure reason for 409 is not printed. Outcome changed versus historical run, but scheduling/race root cause is not proven.',['python/tests/test_release_regressions.py']
    if n.startswith('test_resource_scheduler_enforces_ram'):
        return 'resource_policy_contract','Resource admission raises InsufficientRam instead of expected ResourceBudgetExceeded with no existing reservation.','Confirmed changed error classification: scheduler explicitly uses InsufficientRam before any reservation and ResourceBudgetExceeded for contention.',['python/tests/test_resource_scheduler.py','python/backend/processing/resource_scheduler.py']
    if n.startswith(('test_resource_scheduler_rejects_vram','test_resource_scheduler_enforces_vram')):
        return 'resource_policy_contract','No DependencyError is raised for vramBytes-only provider in AUTO mode.','Confirmed capability-policy mismatch: fixture supplies neither supportsCuda nor requiresCuda; current policy selects CPU and does not validate CUDA memory. Not explained by actual GPU availability.',['python/tests/test_resource_scheduler.py','python/backend/processing/compute_policy.py','python/backend/processing/resource_scheduler.py']
    if n.startswith(('test_deployment_','test_successful_deployment')):
        return 'linux_deployment_sandbox_path','Sandbox deploy.sh fails before injection because interpreter path contains the temporary directory twice; interpreter not found, exit 127 in successful variant.','Confirmed test path rewrite error: first replacing /opt/... with a path under /tmp then globally replacing /tmp also rewrites the newly inserted path. This test never reaches the intended deployment failure/rollback gate.',['python/tests/test_room_server_deployment.py','scripts/deploy-room-server.sh']
    if n.startswith(('test_processing_refreshes_recognition','test_processing_upgrades_catalog','test_processing_retries_video','test_recognition_refresh_preserves','test_rejected_fingerprint')):
        return 'song_metadata_refresh','Expected refreshed title/artist/video/catalogue album/genre is absent or old in the returned song.','Observed metadata refresh mismatch; one assertion per case does not establish a single shared root cause.',['python/tests/test_song_recognition.py']
    if n.startswith(('test_normal_take_balance','test_a_silent_microphone','test_mastering_rejects','test_mastering_keeps')) or (n.startswith('test_studio_master_preserves') and '[True-' in n):
        return 'studio_master_api_contract','Test calls absent balance_recording/_integrated_loudness or unsupported render(enhance=...).','Confirmed test/API incompatibility in unrelated recording mastering component.',['python/tests/test_studio_master.py','python/backend/recordings/studio_master.py']
    if n.startswith('test_studio_master_raises_quiet'):
        return 'studio_master_fixture_input','render immediately calls sf.info on performance_mix take.wav, which the mock test has not provided; libsndfile reports system error.','Missing actual input file at the current render boundary is confirmed; expected mock behavior differs.',['python/tests/test_studio_master.py','python/backend/recordings/studio_master.py']
    if n.startswith('test_studio_master_preserves'):
        return 'studio_master_loudness_behavior','Measured integrated output loudness is -10.95, -20.85, -6.55 or -20.35 LUFS, versus test target -14±0.25.','Observed mastering/loudness behavior mismatch. No justification to classify as CPU/CUDA or word timing.',['python/tests/test_studio_master.py','python/backend/recordings/studio_master.py']
    raise ValueError(n)
rows=[]
for node in ids:
    name=node.split('::')[-1];block=blocks[name];category,immediate,reason,paths=classify(name)
    evidence=[line for line in block.splitlines() if line.startswith(('E ','tests/','backend/'))]
    if category=='cuda_embedding_dtype':evidence=[line for line in evidence if 'Parameter containing' not in line and not line.startswith('E    +')]
    existed=node not in historical['newlyFailingComparedWithHistoricalV1Run']
    rows.append({'nodeId':node,'category':category,'immediateCause':immediate,'rootCauseStatus':reason,'historicalV1Failure':existed,'sourceEvidence':[str(BASE/p) for p in paths if (BASE/p).exists()],'savedLogEvidence':evidence[:8],'baselineLog':str(ROOT/'pytest.log'),'relatedToTargetedWordRepair':category=='targeted_word_alignment'})
result={'scope':'Read-only classification of 62 observed failures in fresh baseline-v1 full pytest. No failures ignored, tests skipped, expectations changed, or product edits.','counts':dict(sorted(Counter(r['category'] for r in rows).items())),'totalFailures':len(rows),'failureRows':rows,'historicalOutcomeChanges':historical,'caveats':['Baseline contains real failing contracts/behaviors, not a green suite.','Only changed pass/fail membership is established for asynchronous cases; exact nondeterminism/race causes are not proven.','The CUDA embedding test uses mocked transfer and cannot be excused as missing GPU.','CUDA/CPU execution-budget tests contain 16000 byte total-RAM fixture despite 16 GiB available RAM; actual runtime resource exhaustion is not the observed cause.','Historical run environment/package versions overlap, but not every external/timing condition is identical.']}
assert len(rows)==62
(ROOT/'failure-classification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
summary=['READ-ONLY BASELINE FAILURE CLASSIFICATION','62 failures; all preserved as gates.','']
for cat,count in result['counts'].items():
    representative=next(r for r in rows if r['category']==cat)
    summary += [f'{cat}: {count}',representative['immediateCause'],representative['rootCauseStatus'],'Evidence: '+representative['nodeId'],'']
summary += ['ASYNC OUTCOME VARIATION','Historical 64 vs current 62:59 shared failures;3 newly failing,5 not failing now. Outcome variation is observed; blanket flaky/hardware attribution is unjustified.']
(ROOT/'failure-classification.txt').write_text('\n'.join(summary)+'\n')
print(json.dumps({'totalFailures':len(rows),'counts':result['counts']},indent=2))
