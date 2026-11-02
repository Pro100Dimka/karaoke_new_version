"""Classify completed backend gates without changing source or running tests."""
from collections import Counter, defaultdict
from hashlib import sha256
import json
from pathlib import Path
import re


ROOT = Path(__file__).parent
BASE = Path('/tmp/karaoke-sync-v3/backend-checks')
FINAL = ROOT / 'backend-checks'

COMPONENTS = {
    'test_architecture.py': ('architecture', 'Общая архитектура', 'cross_cutting'),
    'test_cache_logging_imports.py': ('backend_startup', 'Импорт и запуск backend', 'unrelated_to_word_timing'),
    'test_command_ai_provider.py': ('ai_recognition_reuse', 'Передача и повторное использование ASR', 'alignment_pipeline_support'),
    'test_letter_alignment.py': ('speech_model_runtime', 'Загрузка speech-модели / CUDA', 'alignment_pipeline_support'),
    'test_library_archive.py': ('library_archives', 'Библиотека и архивы', 'unrelated_to_word_timing'),
    'test_process_ownership.py': ('child_process_control', 'Управление дочерними процессами', 'unrelated_to_word_timing'),
    'test_packages_e2e.py': ('package_jobs', 'Подготовка песни и экспорт пакетов', 'unrelated_to_word_timing'),
    'test_processing_e2e.py': ('parallel_clip_processing', 'Параллельная обработка видеоклипа', 'unrelated_to_word_timing'),
    'test_processing_execution.py': ('processing_execution', 'Планирование этапов AI', 'alignment_pipeline_support'),
    'test_recording_empty_cleanup.py': ('recording_lifecycle', 'Жизненный цикл записей', 'unrelated_to_word_timing'),
    'test_recording_startup_recovery.py': ('recording_lifecycle', 'Жизненный цикл записей', 'unrelated_to_word_timing'),
    'test_recordings_analysis.py': ('recording_lifecycle', 'Жизненный цикл записей', 'unrelated_to_word_timing'),
    'test_release_regressions.py': ('recording_lifecycle', 'Жизненный цикл записей', 'unrelated_to_word_timing'),
    'test_resource_scheduler.py': ('resource_budget', 'Бюджет RAM/VRAM', 'unrelated_to_word_timing'),
    'test_room_server_deployment.py': ('room_deployment', 'Развертывание Room Server', 'unrelated_to_word_timing'),
    'test_song_recognition.py': ('song_metadata', 'Определение метаданных песни', 'unrelated_to_word_timing'),
    'test_studio_master.py': ('recording_mastering', 'Мастеринг записей', 'unrelated_to_word_timing'),
    'test_sung_boundary_regressions.py': ('word_timing_accuracy', 'Границы слов и диагностика нормализации', 'word_timing_accuracy'),
}


def traces(text):
    headers = list(re.finditer(r'^_+ (.*?) _+$', text, re.M))
    failed = re.findall(r'^FAILED (\S+)', text, re.M)
    result = {}
    for index, header in enumerate(headers):
        stop = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        block = text[header.end():stop].split('warnings summary')[0]
        location = re.search(r'^(tests/[^:]+):\d+', block, re.M)
        if location is None:
            continue
        matches = [node for node in failed if node.split('::', 1)[1] == header.group(1)]
        node = matches[0] if len(matches) == 1 else location.group(1) + '::' + header.group(1)
        messages = re.findall(r'^E\s+(.*)$', block, re.M)
        frames = [{'file': f, 'line': int(n), 'function': fn}
                  for f, n, fn in re.findall(r'^(\S+\.py):(\d+): in (.+)$', block, re.M)]
        result[node] = {'errorLines': messages, 'traceFrames': frames,
                        'traceExcerpt': block.strip()[:3500]}
    return result


def mechanism(node, trace):
    body = trace['traceExcerpt']
    file = node.split('::')[0].rsplit('/', 1)[-1]
    if file == 'test_architecture.py':
        return 'architecture_debt', 'Архитектурный gate обнаруживает нарушения размера/сложности и другие правила; см. полный architecture.log.'
    if file == 'test_cache_logging_imports.py' and 'External process timed out' in body:
        return 'import_process_timeout', 'Дочерний процесс import backend.main не завершился за timeout_seconds=5; проверки отсутствия побочных эффектов файловой системы еще не выполнялись.'
    if file == 'test_command_ai_provider.py' and "'alternatives'" in body:
        return 'asr_alternatives_payload', 'В переданном ASR payload есть дополнительное поле alternatives, которого не ожидает сравнение с evidence[0].'
    if file == 'test_letter_alignment.py' and 'torch.float16 == torch.float32' in body:
        return 'cuda_embedding_dtype', 'Embedding имеет dtype float16, тогда как тест требует сохранения float32 при переносе на CUDA.'
    if "has no attribute '_publish'" in body:
        return 'library_publish_api', 'Тест ожидает SqlLibraryStorage._publish, отсутствующий в текущем API.'
    if 'Native voice relay closed its control pipe' in body:
        return 'native_control_pipe_closed', 'Управляющий канал дочернего native-процесса закрывается до ожидаемого сценария остановки.'
    if file == 'test_processing_e2e.py':
        if 'before the clip stopped' in body:
            return 'clip_cancel_order', 'Задание освобождает ресурсы раньше подтвержденной остановки параллельного клипа.'
        if 'endswith' in body and 'youtube.com' in body:
            return 'clip_url_contract', 'Возвращается исходная YouTube-ссылка вместо ожидаемого локального URL /songs/.../clip.'
    if 'did not finish before timeout' in body:
        return 'background_job_timeout', 'Фоновое задание не завершилось за timeout=10s в tests/helpers.py; дальнейшая проверка экспорта/импорта не выполнена.'
    if "has no attribute 'music'" in body:
        return 'processing_context_music', 'Контекст SimpleNamespace в тесте не содержит обязательного music.'
    if 'InsufficientRam' in body and file == 'test_processing_execution.py':
        return 'processing_ram_budget', 'Задание завершается Failed/InsufficientRam вместо Succeeded; до проверки передачи бюджета дело не доходит.'
    if file == 'test_recording_empty_cleanup.py' and '204 == 409' in body:
        return 'recording_cleanup_status', 'Удаление отвечает 204, тогда как для нераспознанного дополнительного файла ожидается 409.'
    if 'RecordingNotFound' in body and file == 'test_recording_startup_recovery.py':
        return 'recording_startup_not_found', 'После startup recovery API отвечает RecordingNotFound/404 вместо ожидаемой доступной записи/200.'
    if 'RecordingPreparing' in body or "'Preparing' == 'Ready'" in body or 'StudioMasterUnavailable' in body:
        return 'recording_preparing_state', 'Подготовка записи еще не завершена: Preparing/RecordingPreparing/StudioMasterUnavailable вместо ожидаемого Ready либо запуска анализа/мастеринга.'
    if 'assert entered.wait(3)' in body:
        return 'analysis_entry_not_signaled', 'Сигнал входа в FakeAiProvider.pitch не установлен за3s после немедленного запроса анализа; короткая трассировка не выводит полученный JSON-ответ.'
    if "KeyError: 'jobId'" in body:
        return 'missing_analysis_job_id', 'Ответ API не содержит ожидаемый jobId; короткая трассировка сама по себе не устанавливает полную причину ответа.'
    if 'FileNotFoundError:' in body and 'recording.original.wav' in body:
        return 'missing_original_take', 'Исходный файл recording.original.wav отсутствует в ожидаемой точке жизненного цикла записи.'
    if file == 'test_resource_scheduler.py':
        if 'ResourceBudgetExceeded' in body:
            return 'ram_error_code_contract', 'Фактический код InsufficientRam не совпадает с ожидаемым ResourceBudgetExceeded.'
        return 'vram_dependency_not_raised', 'Для условий VRAM/CUDA не выбрасывается ожидаемый DependencyError.'
    if file == 'test_room_server_deployment.py' and 'No such file or directory' in body:
        return 'deployment_python_path', 'Сгенерированный deploy.sh обращается к пути Python с повторно подставленным временным префиксом; файла нет, часть сценариев завершается кодом127 до проверяемого шага.'
    if file == 'test_song_recognition.py' and 'AssertionError:' in body:
        return 'song_metadata_refresh', 'После обработки ожидаемые title/artist/album/genre/video_url не обновлены; конкретное поле приведено в трассировке.'
    if "unexpected keyword argument 'enhance'" in body:
        return 'mastering_render_api', 'render() не принимает ожидаемый тестом аргумент enhance.'
    if "has no attribute 'balance_recording'" in body:
        return 'mastering_balance_api', 'У FfmpegStudioMasterRenderer отсутствует ожидаемый balance_recording().'
    if "has no attribute '_integrated_loudness'" in body:
        return 'mastering_loudness_api', 'У FfmpegStudioMasterRenderer отсутствует ожидаемый _integrated_loudness().'
    if 'LibsndfileError:' in body:
        return 'mastering_audio_open', 'libsndfile не может открыть ожидаемый take.wav; непосредственная ошибка открытия файла.'
    if file == 'test_studio_master.py' and ('-14' in body or 'input_i' in body):
        return 'mastering_loudness_target', 'Измеренная громкость не совпадает с ожидаемыми -14 LUFS ±0.25.'
    if file == 'test_sung_boundary_regressions.py' and 'not word.diagnostics' in body:
        return 'minor_overlap_diagnostic_regression', 'Небольшое10ms перекрытие получило диагностический флаг; это наблюдаемая регрессия проверки нормализации, не ошибка измеренных длительностей.'
    return 'unclassified', 'Требуется отдельный разбор; не классифицировано автоматически как регрессия v4.'


def read_gate(directory):
    result_path, log_path = directory / 'result.json', directory / 'pytest.log'
    result = json.loads(result_path.read_text())
    log = log_path.read_text()
    ids = re.findall(r'^FAILED (\S+)', log, re.M)
    assert ids == result['failureIDs']
    assert result['failureCount'] == len(ids)
    details = traces(log)
    assert set(ids) == set(details), (set(ids) - set(details), set(details) - set(ids))
    return result, details, {'directory': str(directory),
        'resultSha256': sha256(result_path.read_bytes()).hexdigest(),
        'pytestLogSha256': sha256(log_path.read_bytes()).hexdigest(),
        'summary': result['pytestSummary'], 'sourceUnchanged': result['sourceUnchanged']}


def normalize_gate_line(line):
    line = re.sub(r':\d+:', ':LINE:', line)
    line = re.sub(r'(has |: )\d+ lines', r'\1N lines', line)
    return re.sub(r'complexity proxy \d+', 'complexity proxy N', line)


def static_gate_comparison():
    reports = {}
    for gate in ('architecture', 'mypy', 'format', 'lint', 'compile', 'bootstrap'):
        before = (BASE / (gate + '.log')).read_text()
        after = (FINAL / (gate + '.log')).read_text()
        if gate == 'format':
            before_keys = set(re.findall(r'-->\s+([^:\n]+):\d+', before))
            after_keys = set(re.findall(r'-->\s+([^:\n]+):\d+', after))
        else:
            before_keys = {normalize_gate_line(line) for line in before.splitlines()}
            after_keys = {normalize_gate_line(line) for line in after.splitlines()}
        reports[gate] = {
            'baselineLogSha256': sha256(before.encode()).hexdigest(),
            'finalLogSha256': sha256(after.encode()).hexdigest(),
            'newNormalizedDiagnostics': sorted(after_keys - before_keys),
            'removedNormalizedDiagnostics': sorted(before_keys - after_keys),
            'normalization': 'Locations and numeric size/complexity metrics normalized; format compares affected file sets.',
            'baselineMetricLines': before.splitlines() if gate in ('architecture', 'mypy') else [],
            'finalMetricLines': after.splitlines() if gate in ('architecture', 'mypy') else [],
        }
        if gate == 'format':
            reports[gate]['baselineFiles'] = sorted(before_keys)
            reports[gate]['finalFiles'] = sorted(after_keys)
    return reports


if not (FINAL / 'result.json').exists():
    raise SystemExit('Final gate has not completed: no analysis emitted from an incomplete run.')
before, old_traces, baseline_proof = read_gate(BASE)
after, new_traces, final_proof = read_gate(FINAL)
old_ids, new_ids = set(before['failureIDs']), set(after['failureIDs'])
investigation_path = ROOT / 'failure-reruns' / 'investigation.json'
investigation = json.loads(investigation_path.read_text())
investigated_cases = {case['nodeId']: case for case in investigation['cases']}
import_results_path = ROOT / 'failure-reruns' / 'import-results.json'
import_results = json.loads(import_results_path.read_text())
import_node = import_results['runs'][0]['nodeId']
investigated_cases[import_node] = {
    'nodeId': import_node,
    'exactV3FailureReproducedIndividually': False,
    'historicalExactFailureOnIdenticalBackendSource': False,
    'evidence': import_results['runs'],
    'interpretation': 'The final full gate timed out at the existing 5-second import limit. Exact isolated tests passed on v3 (2.59s) and v4 (2.62s). An earlier exact v3 timeout has not been demonstrated; this is a newly observed timeout with no confirmed v4 cause, not a proven pre-existing failure.',
}
records = []
for node in sorted(old_ids | new_ids):
    file = node.split('::')[0]
    component, label, relation = COMPONENTS.get(Path(file).name,
        ('unclassified', 'Не классифицировано', 'unknown'))
    current = new_traces.get(node)
    original = old_traces.get(node)
    kind, explanation = mechanism(node, current or original)
    old_kind = mechanism(node, original)[0] if original else None
    extra = investigated_cases.get(node)
    earlier_exact = bool(original or extra and (
        extra['exactV3FailureReproducedIndividually'] or
        extra['historicalExactFailureOnIdenticalBackendSource'] or
        extra.get('historicalExactFailureBeforeV4', False)))
    exact_v3 = bool(original or extra and (
        extra['exactV3FailureReproducedIndividually'] or
        extra['historicalExactFailureOnIdenticalBackendSource']))
    records.append({
        'nodeId': node, 'file': file, 'component': component, 'componentLabel': label,
        'syncRelation': relation, 'baselineFailed': node in old_ids, 'finalFailed': node in new_ids,
        'presentBeforeV4': earlier_exact, 'failureMechanism': kind,
        'exactV3SourceFailureEvidence': exact_v3,
        'baselineFailureMechanism': old_kind, 'failureExplanation': explanation,
        'sameFailureMechanismBeforeV4': bool(current and (
            original and old_kind == kind or
            extra and earlier_exact and (
                kind == 'background_job_timeout' or
                extra.get('historicalFailureMechanism') == kind))),
        'baselineEvidence': original, 'finalEvidence': current,
        'additionalInvestigation': extra,
    })

file_groups, component_groups, mechanism_groups = defaultdict(list), defaultdict(list), defaultdict(list)
for record in records:
    file_groups[record['file']].append(record)
    component_groups[record['component']].append(record)
    if record['finalFailed']:
        mechanism_groups[record['failureMechanism']].append(record)


def grouping(groups, key):
    return [{key: name, 'label': values[0]['componentLabel'],
             'baselineCount': sum(v['baselineFailed'] for v in values),
             'finalCount': sum(v['finalFailed'] for v in values),
             'newFailureCount': sum(v['finalFailed'] and not v['baselineFailed'] for v in values),
             'syncRelation': values[0]['syncRelation'],
             'finalFailureIDs': [v['nodeId'] for v in values if v['finalFailed']],
             'failureMechanisms': dict(Counter(v['failureMechanism'] for v in values if v['finalFailed']))}
            for name, values in sorted(groups.items())]


document = {
    'status': 'completed_final_gate_compared', 'baseline': baseline_proof, 'final': final_proof,
    'comparison': {'baselineFailureCount': len(old_ids), 'finalFailureCount': len(new_ids),
        'sameFailureIDs': sorted(old_ids & new_ids), 'newFailureIDs': sorted(new_ids - old_ids),
        'baselineFailuresAbsentFromFinal': sorted(old_ids - new_ids),
        'sameIDChangedFailureMechanism': [r['nodeId'] for r in records
             if r['baselineFailed'] and r['finalFailed'] and not r['sameFailureMechanismBeforeV4']],
        'finalFailuresWithEarlierExactEvidence': sum(r['finalFailed'] and r['presentBeforeV4'] for r in records),
        'finalFailuresWithExactV3SourceEvidence': sum(r['finalFailed'] and r['exactV3SourceFailureEvidence'] for r in records),
        'finalFailuresWithOlderHistoricalEvidenceOnly': [r['nodeId'] for r in records if r['finalFailed'] and r['presentBeforeV4'] and not r['exactV3SourceFailureEvidence']],
        'finalFailuresWithoutEarlierExactEvidence': [r['nodeId'] for r in records if r['finalFailed'] and not r['presentBeforeV4']]},
    'byFile': grouping(file_groups, 'file'), 'byComponent': grouping(component_groups, 'component'),
    'byFailureMechanism': [{'mechanism': key, 'count': len(values),
                            'explanation': values[0]['failureExplanation'],
                            'nodeIds': [v['nodeId'] for v in values]}
                           for key, values in sorted(mechanism_groups.items())],
    'syncRelationCounts': dict(Counter(r['syncRelation'] for r in records if r['finalFailed'])),
    'gateChecks': {'baseline': before['checks'], 'final': after['checks']},
    'staticGateComparison': static_gate_comparison(), 'failures': records,
    'additionalInvestigation': {
        'pairedAndHistoricalInvestigationPath': str(investigation_path),
        'pairedAndHistoricalInvestigationSha256': sha256(investigation_path.read_bytes()).hexdigest(),
        'pairedAndHistoricalInvestigation': investigation,
        'finalImportRepeatPath': str(import_results_path),
        'finalImportRepeatSha256': sha256(import_results_path.read_bytes()).hexdigest(),
        'finalImportRepeat': import_results,
        'importTimeoutPresentInCurrentFinalGate': import_node in new_ids,
    },
    'limitations': [
        'Classification is based on exact test IDs and retained traceback evidence, not on test names alone.',
        'Tracebacks establish immediate failure mechanisms; unrelated subsystems were not exhaustively debugged or modified.',
        'Pre-existing failure IDs do not by themselves prove every aspect of behavior is unchanged; mechanism comparisons and full logs are retained.',
        'Variations in asynchronous recording tests may change the observed failing set without source changes; any newly observed final failure is explicitly listed.',
        'The interrupted backend-checks-before-extraction run is not used as the final result.',
        'The superseded backend-checks-before-hop-tolerance gate is not used as the final result; its additional failure investigation is retained separately.',
        'The import timeout observed in a superseded v4 gate did not reproduce in individual v3/v4 commands. Whether it also occurs in the current final gate is stated explicitly in additionalInvestigation.',
    ],
}
(ROOT / 'test-failure-analysis.json').write_text(json.dumps(document, ensure_ascii=False, indent=2))
lines = ['Сравнение backend-тестов: v3 и окончательный gate v4', '',
         'v3: ' + baseline_proof['summary'], 'v4: ' + final_proof['summary'],
         f'Совпадающих ID падений: {len(old_ids & new_ids)}; новых относительно v3: {len(new_ids-old_ids)}; отсутствующих в финальном прогоне: {len(old_ids-new_ids)}.', '',
         'По компонентам (v3 -> v4):']
for row in document['byComponent']:
    lines.append(f"- {row['label']}: {row['baselineCount']} -> {row['finalCount']}.")
lines += ['', 'Непосредственные механизмы падений:']
for row in document['byFailureMechanism']:
    lines.append(f"- {row['count']}: {row['explanation']}")
lines += ['', 'Проверки точности границ слов/букв следует отличать от сопутствующих проверок ASR payload, загрузки CUDA-модели и планирования этапов. Перечень каждого ID и обе трассировки находятся в JSON.',
          'Полная первопричина несвязанных с v4 подсистем не устанавливалась; они не исправлялись.',
          'Полный gate остается неуспешным при наличии любых перечисленных падений. Промежуточный прерванный прогон исключен.']
if new_ids-old_ids:
    lines += ['', 'Новые наблюдаемые ID (нельзя автоматически считать доказанной регрессией кода):', *sorted(new_ids-old_ids)]
lines += ['', 'Дополнительная проверка новых ID:',
          '- Экспорт 90-секундного аудио: тот же 10-секундный timeout воспроизведен отдельной командой на точной v3 и v4. Падение также присутствует в историческом gate с совпадающими хэшами всех 369 исходных файлов backend.',
          '- Импорт backend.main: ' + ('в текущем финальном gate снова превышен предел 5 секунд.' if import_node in new_ids else 'timeout был в замененном прогоне, а в текущем финальном прогоне этот тест проходит.') + ' Изолированные повторы прошли на v3 (2.59 с) и v4 (2.62 с). Прежнее точное v3-падение не доказано; не выдаем это наблюдение за подтвержденную регрессию кода.',
          f"- Для {document['comparison']['finalFailuresWithEarlierExactEvidence']} из {len(new_ids)} финальных падений есть точное доказательство существования до v4.",
          f"- Для {document['comparison']['finalFailuresWithExactV3SourceEvidence']} падений доказательство относится к точному исходнику v3; для {len(document['comparison']['finalFailuresWithOlderHistoricalEvidenceOnly'])} — к более раннему pre-v4 gate с идентичными вовлеченными файлами (все детали и хэши приведены в JSON).",
          f"- Падений проверок измеренных границ слов/букв: {document['syncRelationCounts'].get('word_timing_accuracy', 0)}.",
          '- Дополнительные проверки подготовки записей сохранены отдельно. Для трех ID есть точные исходные/исторические воспроизведения; для параметра [duration] доказан прежний общий механизм отсутствия jobId до чтения параметра, но точное v3-падение [duration] не воспроизведено.',
          '', 'Статические проверки:']
for name in ('compile', 'bootstrap', 'lint'):
    lines.append(f"- {name}: exit_code={after['checks'][name]['exit_code']}.")
for name in ('architecture', 'mypy', 'format'):
    comparison = document['staticGateComparison'][name]
    lines.append(f"- {name}: новых нормализованных диагностик {len(comparison['newNormalizedDiagnostics'])}, исчезнувших {len(comparison['removedNormalizedDiagnostics'])}; сырые логи сохранены и не объявляются идентичными.")
same_count = len(old_ids & new_ids)
extra_v3 = document['comparison']['finalFailuresWithExactV3SourceEvidence'] - same_count
older_only = len(document['comparison']['finalFailuresWithOlderHistoricalEvidenceOnly'])
unproven = len(document['comparison']['finalFailuresWithoutEarlierExactEvidence'])
lines += ['', f'Происхождение: {same_count} совпадают с полным v3 gate; {extra_v3} дополнительно подтверждены на точном исходнике v3; {older_only} — в более раннем pre-v4 gate; {unproven} без доказанного прежнего падения.',
          '', f'Все {len(new_ids)} ID окончательного прогона:']
for record in records:
    if not record['finalFailed']:
        continue
    origin = ('тот же ID/механизм в полном v3 gate' if record['baselineFailed'] else
              'точное падение на исходнике v3 доказано индивидуальным/историческим прогоном' if record['exactV3SourceFailureEvidence'] else
              'точное падение в более раннем pre-v4 gate; вовлеченные файлы идентичны v3' if record['presentBeforeV4'] else
              'новый наблюдаемый ID; см. отдельное исследование и ограничения')
    lines.append(f"- {record['nodeId']} — {origin}.")
(ROOT / 'test-failure-analysis.txt').write_text('\n'.join(lines) + '\n')
print(json.dumps({'baseline': baseline_proof['summary'], 'final': final_proof['summary'],
    'same': len(old_ids & new_ids), 'new': sorted(new_ids-old_ids), 'absent': sorted(old_ids-new_ids),
    'unclassified': [r['nodeId'] for r in records if r['finalFailed'] and r['failureMechanism']=='unclassified']},ensure_ascii=False,indent=2))
