"""Repack delivered v4, preserving every unrelated entry byte for byte."""
from pathlib import Path
from hashlib import sha256
import json
import zipfile

ROOT=Path('/workspace/scratch/513dbcd967bf')
WORK=Path('/tmp/karaoke-v5-artists')
DEST=ROOT/'deliverables-v5-artists'
REPO=ROOT/'project/karaoke_new_version-refactor-frontend-direct'
BASE=ROOT/'deliverables-v4-repacked/karaoke_word_sync_v4_repacked.zip'
PREFIX='karaoke_new_version-refactor-frontend-direct/'

def digest(path):
    return sha256(path.read_bytes()).hexdigest()

assert digest(BASE)=='d70074fc0d31c915a7aea7619959c26424ebcf25fe7950350b21bf18cda13568'
freeze=json.loads((WORK/'final-source-freeze-v5.json').read_text())
for name,value in freeze['files'].items():
    assert digest(REPO/name)==value,name
inventory=json.loads((WORK/'final-scoped-diff-inventory-v5.json').read_text())
names=[x['file'] for x in inventory['pythonFiles']]+[inventory['notebook']['file']]
assert len(names)==6
readme='''Karaoke Word Sync: новые песни, финальная проверенная итерация (v5)

Исходная база — ранее доставленный karaoke_word_sync_v4_repacked.zip.
Изменены два производственных Python-файла и пересобран существующий Kaggle notebook;
добавлены три регрессионных тестовых файла (20 случаев). Остальные старые ZIP entries
сохранены без изменения содержимого. Все рабочие v2/v3/v4-исправления остаются.

Сначала прочитайте karaoke_v5_report.html или .txt. Полный проектный gate не зелёный:
1336 passed / 60 failed / 6 skipped. У новых исполнителей отсутствуют независимые
точные word/phone labels; нет заявления о полной акустической точности.
Спорные 40 мс начала Пивоварова и оставшиеся ошибки явно описаны в отчёте.

verification-v5-artists содержит отчёт, patch, численные доказательства, сырые тестовые
логи и команды. evidence/harness/REPRODUCTION.txt отделяет переносимые unit tests и
MMS-репродукцию от полного replay, которому нужны записи, тексты, веса и верные пути.
Новые коммерческие аудиофайлы, полные тексты и модели в эту поставку не добавлены.

Компактный review ZIP не является полным проектом: changed-files — только 6 файлов.
v4-to-v5.patch применён и проверен в отдельной копии; итоговые 6 SHA совпали с freeze.
Перед поставкой ZIP проверены CRC и SHA-256. Старые отчёты в составе полной базы
сохранены для истории; актуален отчёт из verification-v5-artists.
'''
(DEST/'README.txt').write_text(readme,encoding='utf-8')
evidence=list(sorted((DEST/'evidence').rglob('*')))
extra=[p for p in evidence if p.is_file()]+[DEST/n for n in ('README.txt','karaoke_v5_report.html','karaoke_v5_report.txt','recovered_word.png','v4-to-v5.patch')]
archive=DEST/'karaoke_word_sync_v5_checked.zip'
with zipfile.ZipFile(BASE) as old,zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as new:
    old_names=set(old.namelist())
    for info in old.infolist():
        rel=info.filename.removeprefix(PREFIX)
        content=(REPO/rel).read_bytes() if rel in names else old.read(info.filename)
        new.writestr(info,content)
    for rel in names:
        if PREFIX+rel not in old_names:new.write(REPO/rel,PREFIX+rel)
    for path in extra:
        name=PREFIX+'verification-v5-artists/'+path.relative_to(DEST).as_posix()
        assert name not in old_names,name
        new.write(path,name)

with zipfile.ZipFile(BASE) as old,zipfile.ZipFile(archive) as new:
    assert new.testzip() is None
    unchanged=0;changed=[]
    assert len(new.namelist())==len(set(new.namelist()))
    for info in old.infolist():
        rel=info.filename.removeprefix(PREFIX)
        if rel in names:
            assert new.read(info.filename)==(REPO/rel).read_bytes();changed.append(rel)
        else:
            assert new.read(info.filename)==old.read(info.filename),info.filename;unchanged+=1
    for name,value in freeze['files'].items():
        assert sha256(new.read(PREFIX+name)).hexdigest()==value,name
    entry_count=len(new.namelist())
assert archive.read_bytes()[:4]==b'PK\x03\x04'
assert archive.stat().st_size>1_000_000
proof={'scope':'Local archive integrity, before upload. Readback delivery verification is reported separately.',
       'baseSha256':digest(BASE),'unchangedOriginalEntries':unchanged,'replacedOriginalFiles':changed,
       'addedProductFiles':[n for n in names if PREFIX+n not in old_names],
       'frozenProductFilesChecked':len(freeze['files']),'duplicatePaths':False,
       'archive':archive.name,'bytes':archive.stat().st_size,'entries':entry_count,
       'sha256':digest(archive),'crcError':None}
(DEST/'PACKAGE_INTEGRITY.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')

review=DEST/'karaoke_word_sync_v5_review.zip'
review_files=extra+[p for p in (DEST/'changed-files').rglob('*') if p.is_file()]+[DEST/'PACKAGE_INTEGRITY.json']
with zipfile.ZipFile(review,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in review_files:z.write(p,'karaoke_word_sync_v5_review/'+p.relative_to(DEST).as_posix())
with zipfile.ZipFile(review) as z:
    assert z.testzip() is None
    assert len(z.namelist())==len(set(z.namelist()))
    for n in names:assert z.read('karaoke_word_sync_v5_review/changed-files/'+n)==(REPO/n).read_bytes()
    review_entries=len(z.namelist())
summary={'full':proof,'review':{'archive':review.name,'bytes':review.stat().st_size,'entries':review_entries,'sha256':digest(review),'crcError':None},
         'report':{'file':'karaoke_v5_report.html','bytes':(DEST/'karaoke_v5_report.html').stat().st_size,'sha256':digest(DEST/'karaoke_v5_report.html')}}
(WORK/'delivery-verification.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(summary,ensure_ascii=False))
