"""Plot source audio and measured intervals; published labels are not perfect truth."""
from pathlib import Path
import argparse
import json
import numpy as np
from scipy.io import wavfile
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument('--after-dir', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
case = 'baikal_breathy_0000'
old_root = Path('/tmp/karaoke-v4-new-songs')
before = json.loads((old_root/'runs/v4-replay'/case/'payload.json').read_text())['words'][3]
after = json.loads((args.after_dir/case/'payload.json').read_text())['words'][3]
reference = next(c for c in json.loads((old_root/'ru-reference/frozen-reference.json').read_text())['cases'] if c['case']==case)['words'][3]
rate, samples = wavfile.read(old_root/'ru-reference/data'/f'{case}.wav')
if np.issubdtype(samples.dtype, np.integer):
    samples = samples.astype(float) / (float(np.iinfo(samples.dtype).max) + 1)
if samples.ndim == 2:
    samples = samples.mean(axis=1)
times = np.arange(len(samples))/rate
begin = 3.9
end = len(samples)/rate
mask = (times>=begin)&(times<=end)
fig, axes = plt.subplots(2,1, figsize=(12,6.4), sharex=True, gridspec_kw={'height_ratios':[2,1]})
axes[0].plot(times[mask],samples[mask],color='#455f78',linewidth=.6)
axes[0].set_ylabel('Амплитуда исходной записи')
axes[0].axvspan(before['start'],before['end'],color='#d36549',alpha=.22)
axes[0].axvspan(after['start'],after['end'],color='#2c947c',alpha=.15)
axes[0].set_title('«смотрят»: преждевременный интервал и восстановленный вокальный вход',loc='left',fontsize=13)
for y,label,word,color in [(2,'v4',before,'#d36549'),(1,'Исправленная версия',after,'#2c947c'),(0,'Опубликованная разметка GTSinger',reference,'#6670b1')]:
    axes[1].broken_barh([(word['start'],word['end']-word['start'])],(y-.22,.44),facecolors=color)
    axes[1].text(word['start'],y+.27,f"{word['start']:.3f}–{word['end']:.3f} с",fontsize=10,color=color)
axes[1].set_yticks([0,1,2],['Внешняя разметка','Исправленная версия','v4'])
axes[1].set_ylim(-.5,2.65)
axes[1].set_xlim(begin,end)
axes[1].set_xlabel('Время внутри исходного фрагмента, с')
for ax in axes:
    ax.grid(axis='x',alpha=.2)
    ax.spines[['top','right']].set_visible(False)
fig.text(.01,.015,'Граница конца спорна: расхождение с внешней меткой не доказывает отсутствие вокала. '
         'Запись и её скорость не изменялись.',fontsize=9,color='#555555')
fig.tight_layout(rect=(0,.045,1,1))
args.output.parent.mkdir(parents=True,exist_ok=True)
fig.savefig(args.output,dpi=150)
plt.close(fig)
