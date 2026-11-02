"""Render selected-word diagnostics using unchanged JSON and production timing.

The private layout/samples retain full text for the production frontend sampler.
Only the MP4 and render-result.json are intended for distribution.
"""
from pathlib import Path
from hashlib import sha256
import argparse
import json
import math
import subprocess
import time
import unicodedata

import numpy as np
from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT, FPS = 1280, 720, 60
FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FEATURES = ['-kern', '-liga']
BG = (10, 17, 29)
TEXT = (227, 233, 244)
MUTED = (128, 146, 168)
GOLD = (255, 211, 93)
PUNCT = set(" \t\n.,!?;:'’ʼ‘\"()-–—…«»„“”ьъ")
MAX_VISIBLE_WORDS = 10


def visible_indices(value):
    """A bounded set of zero-based indices; filtering never edits the document."""
    try:
        indices = [int(part.strip()) for part in value.split(',')]
    except ValueError as error:
        raise argparse.ArgumentTypeError('Expected comma-separated word indices') from error
    if not indices or len(indices) > MAX_VISIBLE_WORDS or any(i < 0 for i in indices):
        raise argparse.ArgumentTypeError('Select between 1 and 10 nonnegative word indices')
    if len(set(indices)) != len(indices):
        raise argparse.ArgumentTypeError('Word indices must be unique')
    return frozenset(indices)


def font(size, bold=False):
    return ImageFont.truetype(BOLD_PATH if bold else FONT_PATH, size)


def digest(path):
    return sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')


def clock(value):
    total = round(value * 1000)
    return f'{total // 60000:02d}:{total // 1000 % 60:02d}.{total % 1000:03d}'


def width(text, face):
    return face.getlength(text, features=FEATURES)


def geometry(text, face):
    full = width(text, face)
    assert full > 0
    return [[width(text[:i], face)/full, width(text[:i+1], face)/full]
            for i in range(len(text))]


def word_tile(text, face, color):
    advance = width(text, face)
    ascent, descent = face.getmetrics()
    tile = Image.new('RGBA', (math.ceil(advance)+4, ascent+descent+8))
    ImageDraw.Draw(tile).text((2, ascent+2), text, fill=color, font=face,
                              anchor='ls', features=FEATURES)
    return tile, advance


def painted_word(text, face, progress, cache):
    key = (text, face.size)
    if key not in cache:
        base, advance = word_tile(text, face, TEXT)
        fill, _ = word_tile(text, face, GOLD)
        cache[key] = base, fill, advance
    base, fill, advance = cache[key]
    result = base.copy()
    if progress >= 1:
        result = fill.copy()
    elif progress > 0:
        edge = min(result.width, max(0, round(2 + advance*progress)))
        result.alpha_composite(fill.crop((0, 0, edge, fill.height)), (0, 0))
    return result, advance


def painted_block(text, face, progress, cache):
    """Hide glyphs while preserving their measured total advance and progress."""
    advance = width(text, face)
    key = ('neutral-block', advance, face.size)
    if key not in cache:
        ascent, descent = face.getmetrics()
        size = (math.ceil(advance)+4, ascent+descent+8)
        bounds = (2, ascent+2-face.size*.66, advance+2, ascent+2)
        base, fill = Image.new('RGBA', size), Image.new('RGBA', size)
        ImageDraw.Draw(base).rounded_rectangle(bounds, radius=4, fill=(49, 67, 87))
        ImageDraw.Draw(fill).rounded_rectangle(bounds, radius=4, fill=(164, 183, 202))
        cache[key] = base, fill, advance
    base, fill, advance = cache[key]
    result = base.copy()
    if progress >= 1:
        result = fill.copy()
    elif progress > 0:
        edge = min(result.width, max(0, round(2 + advance*progress)))
        result.alpha_composite(fill.crop((0, 0, edge, fill.height)), (0, 0))
    return result, advance


def line_image(indices, words, progress, face, cache, visible, upcoming=False):
    space = width(' ', face)
    items = []
    for i in indices:
        painter = painted_word if i in visible else painted_block
        tile, advance = painter(words[i]['text'], face,
                                0 if upcoming else progress[i], cache)
        items.append((tile, advance))
    total = sum(x[1] for x in items) + space*max(0, len(items)-1)
    height = max((x[0].height for x in items), default=1)
    result = Image.new('RGBA', (max(1, math.ceil(total)+4), height))
    x = 0.0
    for tile, advance in items:
        result.alpha_composite(tile, (round(x), 0))
        x += advance + space
    if result.width > 1128:
        scale = 1128/result.width
        result = result.resize((1128, max(1, round(height*scale))), Image.Resampling.LANCZOS)
    return result


def composite_center(image, tile, center_y, opacity=1):
    if opacity < 1:
        tile = tile.copy()
        tile.putalpha(tile.getchannel('A').point(lambda p: round(p*opacity)))
    image.alpha_composite(tile, ((WIDTH-tile.width)//2, round(center_y-tile.height/2)))


def background(case, duration, source_offset):
    yy, xx = np.mgrid[:HEIGHT, :WIDTH]
    glow = np.exp(-(((xx-190)/750)**2 + ((yy-140)/520)**2))
    rgb = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    for channel, initial in enumerate(BG):
        rgb[:, :, channel] = initial + glow * [6, 11, 18][channel]
    canvas = Image.fromarray(rgb).convert('RGBA')
    draw = ImageDraw.Draw(canvas)
    draw.text((52, 35), case['artist'], font=font(37, True), fill=TEXT)
    draw.text((53, 91), case['title'], font=font(25), fill=MUTED)
    label = 'сохранённые времена'
    draw.rounded_rectangle((935, 40, 1227, 80), radius=13, fill=(27, 44, 62), outline=(53, 76, 95))
    draw.text((952, 50), label, font=font(18), fill=(177, 207, 228))
    draw.text((53, 142), 'Выбранные слова · фактические времена JSON', font=font(22), fill=MUTED)
    draw.rounded_rectangle((48, 185, 1232, 440), radius=24, fill=(17, 28, 43), outline=(39, 55, 74), width=2)
    draw.text((75, 206), 'ТЕКУЩАЯ СТРОКА', font=font(15), fill=MUTED)
    draw.text((75, 341), 'ДАЛЕЕ', font=font(13), fill=(101, 120, 143))
    draw.rounded_rectangle((48, 464, 1232, 610), radius=18, fill=(14, 24, 37), outline=(39, 55, 74))
    draw.text((73, 482), 'СЛОВО СЕЙЧАС', font=font(14), fill=MUTED)
    draw.text((418, 482), 'НАЧАЛО / КОНЕЦ В ИСХОДНОЙ ПЕСНЕ', font=font(14), fill=MUTED)
    draw.text((53, 677), '60 кадров/с · обычная скорость · без правки времён', font=font(16), fill=MUTED)
    endpoint = clock(source_offset)+' — '+clock(source_offset+duration)
    draw.text((1227-width(endpoint,font(16)), 677), endpoint, font=font(16), fill=MUTED)
    return canvas


def detail(image, words, active_indices, t, progress, cache, offset, visible):
    draw = ImageDraw.Draw(image)
    active = next((i for i, word in enumerate(words) if word['start'] <= t < word['end']), None)
    if active is None:
        draw.text((74, 519), 'Между словами', font=font(27), fill=MUTED)
        draw.text((418, 518), 'Сохранённый интервал слова сейчас не активен', font=font(20), fill=MUTED)
        return
    word = words[active]
    shown = active in visible
    if shown:
        tile, _ = painted_word(word['text'], font(42, True), progress[active], cache)
    else:
        tile, _ = word_tile(f'Слово № {active + 1}', font(32), MUTED)
    if tile.width > 310:
        tile = tile.resize((310, max(1, round(tile.height*310/tile.width))), Image.Resampling.LANCZOS)
    image.alpha_composite(tile, (73, 511))
    duration = word['end'] - word['start']
    label = f"{clock(offset+word['start'])} — {clock(offset+word['end'])}   ·   {duration*1000:.0f} мс"
    draw.text((418, 509), label, font=font(22), fill=TEXT)
    spoken = [i for i,c in enumerate(word['text']) if c not in PUNCT and not unicodedata.category(c).startswith('M')]
    starts = word.get('letters', [])
    if len(starts) != len(word['text']):
        draw.text((418, 562), 'Буквенные интервалы не сохранены', font=font(17), fill=MUTED)
        return
    for slot, index in enumerate(spoken):
        start = starts[index]
        end = starts[spoken[slot+1]] if slot+1 < len(spoken) else word['end']
        x1 = 418 + (start-word['start'])/duration*785
        x2 = 418 + (end-word['start'])/duration*785
        if x2 <= x1:
            continue
        color = GOLD if start <= t < end else ((77, 90, 100) if t >= end else (38, 54, 72))
        draw.rectangle((round(x1), 557, max(round(x1),round(x2)-1), 594), fill=color)
        if shown and x2-x1 > 28:
            c=word['text'][index];f=font(19, True)
            draw.text(((x1+x2-width(c,f))/2, 563),c,font=f,fill=(13,22,33) if start<=t<end else TEXT)


def render(case, args):
    work = args.work/case['case']; work.mkdir(parents=True, exist_ok=True)
    document = args.documents_root/case['case']/'final/lyricsSync.json'
    doc = json.loads(document.read_text())
    visible = args.visible_word_indices
    if any(i >= len(doc['words']) for i in visible):
        raise ValueError('Visible word index exceeds document word count')
    audio = Path(case['mixPath'])
    initial_hashes={'audio':digest(audio),'lyricsSync':digest(document)}
    assert initial_hashes['audio']==case['mixSha256']
    duration = args.duration
    count = math.ceil(duration*FPS - 1e-8)
    assert args.clip_start >= 0 and 0 < duration and args.clip_start+duration <= doc['duration']
    layout={'schemaVersion':1,'clipStartSeconds':args.clip_start,'fps':FPS,'frameCount':count,
            'words':[{'wordIndex':i,'text':w['text'],'geometry':geometry(w['text'],font(64,True))}
                     for i,w in enumerate(doc['words'])]}
    write_json(work/'layout.private.json',layout)
    command=['node',str(Path(__file__).with_name('sample_frontend.mjs')),'--repo',str(args.repo),
             '--document',str(document),'--layout',str(work/'layout.private.json'),'--output',str(work/'samples.private.json')]
    subprocess.run(command,check=True)
    samples=json.loads((work/'samples.private.json').read_text())
    frame_data=samples['frames']; lines=samples['lines']
    assert len(frame_data)==count
    base=background(case,duration,case['originOffsetSeconds']+args.clip_start)
    output=args.output/f"{case['case']}_selected_words.mp4"
    ffmpeg=['ffmpeg','-y','-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','rgb24',
            '-video_size',f'{WIDTH}x{HEIGHT}','-framerate',str(FPS),'-i','pipe:0','-i',str(audio),
            '-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','20',
            '-profile:v','high','-level:v','4.2','-pix_fmt','yuv420p','-threads','4',
            '-c:a','aac','-b:a','192k','-ar','44100','-af',f'atrim=start={args.clip_start}:end={args.clip_start+duration},asetpts=PTS-STARTPTS',
            '-t',str(duration),'-movflags','+faststart','-metadata',f"title={case['artist']} — {case['title']} — selected words, saved timing",str(output)]
    started=time.perf_counter(); cache={}
    with (work/'ffmpeg.log').open('w') as log:
        encoder=subprocess.Popen(ffmpeg,stdin=subprocess.PIPE,stderr=log)
        try:
            for n,sample in enumerate(frame_data):
                t=sample['timeSeconds']
                assert abs(t-args.clip_start-n/FPS)<1e-10
                image=base.copy(); draw=ImageDraw.Draw(image)
                index=sample['activeLineIndex']; phase=sample['phase']
                progress={v['wordIndex']:v['progress'] for v in sample['words']}
                indices=lines[index]['wordIndices'] if 0<=index<len(lines) else []
                show_line=phase['kind']=='text' or phase.get('countdown')==1
                opacity=phase.get('opacity',1)
                if show_line:
                    tile=line_image(indices,doc['words'],progress,font(64,True),cache,visible)
                    composite_center(image,tile,286,opacity)
                    if sample['previewLineIndex'] >= 0:
                        tile=line_image(lines[sample['previewLineIndex']]['wordIndices'],doc['words'],progress,font(34),cache,visible,True)
                        composite_center(image,tile,386,opacity*.65)
                elif phase['kind']=='countdown':
                    draw.text((620,244),str(phase['countdown']),font=font(68,True),fill=GOLD)
                else:
                    label='Ожидание вокала';face=font(32)
                    draw.text(((WIDTH-width(label,face))/2,265),label,font=face,fill=MUTED)
                detail(image,doc['words'],indices,t,progress,cache,case['originOffsetSeconds'],visible)
                draw=ImageDraw.Draw(image)
                draw.text((53,628),'Фрагмент '+clock(t-args.clip_start),font=font(19),fill=TEXT)
                label='Песня '+clock(t+case['originOffsetSeconds'])
                draw.text((1227-width(label,font(19)),628),label,font=font(19),fill=TEXT)
                draw.rounded_rectangle((53,659,1227,664),radius=2,fill=(44,59,78))
                if t>args.clip_start:draw.rectangle((53,659,53+round(1174*(t-args.clip_start)/duration),664),fill=GOLD)
                if n in {0,round(FPS*.8),round(FPS*2),round(FPS*8),round(FPS*20)}:
                    image.convert('RGB').save(work/f'frame_{n:04d}.png')
                encoder.stdin.write(image.convert('RGB').tobytes())
            encoder.stdin.close(); rc=encoder.wait(); assert rc==0,work/'ffmpeg.log'
        except BaseException:
            encoder.kill();encoder.wait();raise
    assert initial_hashes=={'audio':digest(audio),'lyricsSync':digest(document)}
    result={'case':case['case'],'artist':case['artist'],'title':case['title'],
            'video':str(output),'audio':str(audio),'document':str(document),'hashes':initial_hashes,
            'sourcePage':case['sourcePage'],'sourceOffsetSeconds':case['originOffsetSeconds'],
            'clipStartSeconds':args.clip_start,'clipEndSeconds':args.clip_start+duration,'durationSeconds':duration,'fps':FPS,'frames':count,
            'frameStepSeconds':1/FPS,'frontEndSampler':str(work/'samples.private.json'),
            'presentationFilter':{'type':'selected-word-indices','zeroBased':True,
                                 'visibleWordIndices':sorted(visible),'maximumVisibleWords':MAX_VISIBLE_WORDS,
                                 'unselectedWords':'Neutral blocks with original measured width and native progress',
                                 'unselectedDetail':'Word number and unlabelled timing blocks; no letters',
                                 'label':'Выбранные слова · фактические времена JSON',
                                 'timingAndLineInputsFiltered':False},
            'privateIntermediatesDoNotDistribute':['layout.private.json','samples.private.json'],
            'sourceTimebase':{'audioExcerptOriginSeconds':case['originOffsetSeconds'],
                              'clipStartInExcerptSeconds':args.clip_start,
                              'clipStartInOriginalSongSeconds':case['originOffsetSeconds']+args.clip_start},
            'productionSourceHashes':samples['sourceHashes'],
            'samplerSha256':samples['samplerSha256'],'rendererSha256':digest(__file__),
            'nativeTimingChecks':samples['checks'],
            'timestampsEdited':False,'audioOffsetAdded':False,'audioFilters':['atrim','asetpts'],
            'display':'Programmatic Pillow drawing; actual production editorApi and karaokeLyrics timing, measured glyph advances. Not a recording of Electron.',
            'renderSeconds':time.perf_counter()-started,'videoSha256':digest(output),'videoBytes':output.stat().st_size}
    write_json(work/'render-result.json',result)
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--case',required=True)
    parser.add_argument('--duration',required=True,type=float)
    parser.add_argument('--clip-start',type=float,default=0)
    parser.add_argument('--visible-word-indices',required=True,type=visible_indices,
                        help='Comma-separated zero-based indices; display only 1–10 selected word texts')
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--documents-root',type=Path,required=True)
    parser.add_argument('--repo',type=Path,required=True)
    parser.add_argument('--work',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    manifest=json.loads(args.manifest.read_text())
    case=next(c for c in manifest['cases'] if c['case']==args.case)
    render(case,args)
