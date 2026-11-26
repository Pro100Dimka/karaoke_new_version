import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'Pro100Dimka/karaoke_new_version';
const manifestName = 'ffmpeg-distribution.json';
const installerName = 'AD-Voice-Setup.exe';
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const digest = async (file) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
const verifyFile = async (file, expected) => {
  if (!/^[a-f0-9]{64}$/.test(expected ?? ''))
    throw new Error(
      `Missing reviewed SHA-256 for ${path.basename(file)}. Obtain the complete corresponding source and third-party notices before releasing.`,
    );
  if ((await digest(file)) !== expected)
    throw new Error(
      `${path.basename(file)} SHA-256 does not match the approved FFmpeg distribution.`,
    );
};

const configuration = async (root) => {
  const directory = path.join(root, 'docs/third-party/ffmpeg');
  const approved = await json(path.join(directory, 'distribution.json'));
  const { version: applicationVersion } = await json(
    path.join(root, 'frontend/package.json'),
  );
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(applicationVersion))
    throw new Error(
      'Invalid application version for the FFmpeg source download.',
    );
  for (const item of [approved.sourceArchive, approved.thirdPartyNotices]) {
    if (!item || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name))
      throw new Error('Invalid FFmpeg distribution filename.');
  }
  if (
    !/^FFmpeg-[A-Za-z0-9._-]+-corresponding-source\.zip$/.test(
      approved.sourceArchive.name,
    ) ||
    !approved.thirdPartyNotices.name.endsWith('.txt')
  )
    throw new Error(
      'FFmpeg sources must use a distinct corresponding-source ZIP and notices TXT filename.',
    );
  return {
    directory,
    approved,
    applicationVersion,
    sourceUrl: `https://github.com/${repository}/releases/download/v${applicationVersion}/${approved.sourceArchive.name}`,
  };
};

/** Checks approved inputs before copying any release files. Approval requires a source review. */
export const prepareDistribution = async (
  root,
  ffmpeg,
  ffprobe,
  resources,
  sourceDirectory,
) => {
  const config = await configuration(root);
  const { directory, approved, applicationVersion, sourceUrl } = config;
  sourceDirectory ??= path.join(root, 'vendor/ffmpeg');
  const source = path.join(sourceDirectory, approved.sourceArchive.name);
  const notices = approved.thirdPartyNotices
    ? path.join(sourceDirectory, approved.thirdPartyNotices.name)
    : null;
  await verifyFile(source, approved.sourceArchive.sha256);
  if (!notices) throw new Error('Missing reviewed FFmpeg third-party notices.');
  await verifyFile(notices, approved.thirdPartyNotices.sha256);
  for (const [file, name] of [
    [ffmpeg, 'ffmpeg.exe'],
    [ffprobe, 'ffprobe.exe'],
  ])
    await verifyFile(file, approved.binaries[name]);
  for (const name of ['GPL-3.0.txt', 'BUILD-INFO.txt']) {
    if (!(await stat(path.join(directory, name))).size)
      throw new Error(`Missing FFmpeg documentation: ${name}`);
  }
  const tools = path.join(resources, 'tools');
  const documents = path.join(resources, 'docs/third-party/ffmpeg');
  const releaseDirectory = path.join(root, 'release');
  for (const folder of [tools, documents, releaseDirectory])
    await mkdir(folder, { recursive: true });
  for (const [file, name] of [
    [ffmpeg, 'ffmpeg.exe'],
    [ffprobe, 'ffprobe.exe'],
  ])
    await copyFile(file, path.join(tools, name));
  for (const name of ['GPL-3.0.txt', 'BUILD-INFO.txt'])
    await copyFile(path.join(directory, name), path.join(documents, name));
  await copyFile(notices, path.join(documents, 'THIRD-PARTY-NOTICES.txt'));
  const publishedSource = path.join(
    releaseDirectory,
    approved.sourceArchive.name,
  );
  if (path.resolve(source) !== path.resolve(publishedSource))
    await copyFile(source, publishedSource);
  await copyFile(source, path.join(documents, approved.sourceArchive.name));
  const metadata = { ...approved, applicationVersion, sourceUrl };
  await writeFile(
    path.join(documents, 'distribution.json'),
    JSON.stringify(metadata, null, 2) + '\n',
  );
  await writeFile(
    path.join(documents, 'NOTICE.txt'),
    [
      `FFmpeg ${approved.version}`,
      `License: ${approved.license}`,
      `Upstream: ${approved.upstreamUrl}`,
      'FFmpeg and FFprobe are separate command-line programs. They are not part of the proprietary application license.',
      'You may use, study, modify and redistribute these programs under their applicable licenses.',
    `Complete corresponding source, dependencies, patches and build instructions: ${sourceUrl}`,
    `The same complete source archive is included in this directory: ${approved.sourceArchive.name}`,
      `Source archive SHA-256: ${approved.sourceArchive.sha256}`,
      'See GPL-3.0.txt, THIRD-PARTY-NOTICES.txt and BUILD-INFO.txt in this directory.',
      '',
    ].join('\n'),
  );
  const manifestFile = path.join(releaseDirectory, manifestName);
  let installer = null;
  try {
    const { installer: previousInstaller, ...previous } =
      await json(manifestFile);
    if (JSON.stringify(previous) === JSON.stringify(metadata))
      installer = previousInstaller;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(
    manifestFile,
    JSON.stringify({ ...metadata, installer }, null, 2) + '\n',
  );
  return metadata;
};

/** Binds the source package to the final installer, after signing has finished. */
export const sealDistribution = async (root) => {
  const file = path.join(root, 'release', manifestName);
  const metadata = await json(file);
  await validateMetadata(root, metadata);
  await verifyFile(
    path.join(root, 'release', metadata.sourceArchive.name),
    metadata.sourceArchive.sha256,
  );
  metadata.installer = {
    name: installerName,
    sha256: await digest(path.join(root, 'release', installerName)),
  };
  await writeFile(file, JSON.stringify(metadata, null, 2) + '\n');
};

const validateMetadata = async (root, metadata) => {
  const { approved, applicationVersion, sourceUrl } = await configuration(root);
  if (
    metadata.applicationVersion !== applicationVersion ||
    metadata.sourceUrl !== sourceUrl
  )
    throw new Error(
      'FFmpeg distribution belongs to a different application version. Rebuild the release.',
    );
  for (const key of [
    'version',
    'license',
    'upstreamUrl',
    'binaries',
    'sourceArchive',
    'thirdPartyNotices',
  ]) {
    if (JSON.stringify(metadata[key]) !== JSON.stringify(approved[key]))
      throw new Error(
        'FFmpeg release manifest differs from the approved distribution. Rebuild the release.',
      );
  }
};

/** All public assets are checked locally before the publisher contacts GitHub. */
export const releaseArtifacts = async (root) => {
  const file = path.join(root, 'release', manifestName);
  const metadata = await json(file);
  await validateMetadata(root, metadata);
  if (metadata.installer?.name !== installerName)
    throw new Error(
      'FFmpeg release manifest is not sealed to the final installer. Rebuild the release.',
    );
  const artifacts = [metadata.installer, metadata.sourceArchive];
  for (const artifact of artifacts)
    await verifyFile(
      path.join(root, 'release', artifact.name),
      artifact.sha256,
    );
  artifacts.push({ name: manifestName, sha256: await digest(file) });
  return artifacts.map((artifact) => ({
    ...artifact,
    path: path.join(root, 'release', artifact.name),
  }));
};

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const [command, ffmpeg, ffprobe, resources] = process.argv.slice(2);
    if (command === 'prepare' && ffmpeg && ffprobe && resources)
      await prepareDistribution(root, ffmpeg, ffprobe, resources);
    else if (command === 'seal') await sealDistribution(root);
    else if (command === 'verify-release') await releaseArtifacts(root);
    else
      throw new Error(
        'Usage: node scripts/ffmpeg-distribution.mjs prepare <ffmpeg> <ffprobe> <resources> | seal | verify-release',
      );
    console.log('FFmpeg distribution verified.');
  } catch (error) {
    console.error(`[ffmpeg] ${error.message}`);
    process.exitCode = 1;
  }
}
