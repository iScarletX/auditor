// 统一输入口子：粘贴文本 / 上传单文件 / 上传文件夹 / 上传 zip，最终都归一成一份 targetSp 字符串。
// 多文件场景自动拼接为 packageManifest.ts 期望的 "===== FILE: xxx =====" 格式，
// 不需要用户手动打标记——这是本次改进要解决的核心摩擦点。

import JSZip from 'jszip'

/** 二进制/图片类文件不适合塞进 LLM 文本审查，按扩展名黑名单过滤，不纳入拼包 */
const BINARY_EXT_PATTERN =
  /\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|zip|tar|gz|mp4|mp3|wav|mov|ttf|otf|woff2?|exe|dll|bin)$/i

const MAX_TOTAL_CHARS = 400_000 // 粗略护栏：避免用户误传超大文件夹导致后续 LLM 调用直接爆预算

export interface ImportedFile {
  /** 相对路径，如 references/distill.md；单文件时为原文件名 */
  path: string
  content: string
}

export interface ImportResult {
  ok: boolean
  /** 拼装完成、可直接填入 targetSp 的文本 */
  targetSp: string
  files: ImportedFile[]
  /** 因为二进制等原因被跳过的文件名，供 UI 提示用户 */
  skipped: string[]
  error?: string
}

function isBinaryPath(path: string) {
  return BINARY_EXT_PATTERN.test(path)
}

function sortFiles(files: ImportedFile[]): ImportedFile[] {
  return [...files].sort((a, b) => {
    if (a.path === 'SKILL.md') return -1
    if (b.path === 'SKILL.md') return 1
    return a.path.localeCompare(b.path)
  })
}

/** 单文件（.md/.txt 等文本文件）：直接读内容，不做拼包标记 */
export async function importSingleFile(file: File): Promise<ImportResult> {
  if (isBinaryPath(file.name)) {
    return { ok: false, targetSp: '', files: [], skipped: [file.name], error: `${file.name} 看起来不是文本文件，无法读取内容。` }
  }
  const content = await file.text()
  return { ok: true, targetSp: content, files: [{ path: file.name, content }], skipped: [] }
}

/** 拼装多文件为 packageManifest.ts 能识别的格式 */
function buildTargetSpFromFiles(files: ImportedFile[]): string {
  return sortFiles(files)
    .map((file) => `===== FILE: ${file.path} =====\n${file.content}`)
    .join('\n\n')
}

function buildResultFromFiles(files: ImportedFile[], skipped: string[]): ImportResult {
  if (files.length === 0) {
    return { ok: false, targetSp: '', files: [], skipped, error: '没有找到可读取的文本文件。' }
  }
  const totalChars = files.reduce((sum, file) => sum + file.content.length, 0)
  if (totalChars > MAX_TOTAL_CHARS) {
    return {
      ok: false,
      targetSp: '',
      files: [],
      skipped,
      error: `文件总大小超出限制（${totalChars.toLocaleString()} 字符，上限 ${MAX_TOTAL_CHARS.toLocaleString()}），请拆分后分别审查。`,
    }
  }
  // 单文件文件夹（只选了1个文本文件）不需要拼包标记，直接返回内容，行为与"上传单文件"一致
  if (files.length === 1) {
    return { ok: true, targetSp: files[0].content, files, skipped }
  }
  return { ok: true, targetSp: buildTargetSpFromFiles(files), files: sortFiles(files), skipped }
}

/** 上传文件夹：<input type="file" webkitdirectory> 拿到的 FileList，webkitRelativePath 带完整相对路径 */
export async function importDirectory(fileList: FileList): Promise<ImportResult> {
  const files: ImportedFile[] = []
  const skipped: string[] = []
  for (const file of Array.from(fileList)) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    // 去掉最外层文件夹名前缀，只保留 SKILL.md / references/xxx.md 这种相对路径，方便阅读
    const trimmedPath = relativePath.split('/').slice(1).join('/') || relativePath
    if (isBinaryPath(relativePath) || file.name === '.DS_Store') {
      skipped.push(relativePath)
      continue
    }
    try {
      const content = await file.text()
      files.push({ path: trimmedPath, content })
    } catch {
      skipped.push(relativePath)
    }
  }
  return buildResultFromFiles(files, skipped)
}

/** 上传 zip：解压后按文件夹逻辑处理 */
export async function importZip(file: File): Promise<ImportResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(file)
  } catch {
    return { ok: false, targetSp: '', files: [], skipped: [], error: `${file.name} 不是有效的 zip 文件，或已损坏。` }
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  // 常见打包习惯：整个内容套了一层同名文件夹，检测并剥掉这层，让路径更干净
  const commonPrefix = (() => {
    if (entries.length === 0) return ''
    const firstSegments = entries[0].name.split('/')
    if (firstSegments.length < 2) return ''
    const candidate = `${firstSegments[0]}/`
    return entries.every((entry) => entry.name.startsWith(candidate)) ? candidate : ''
  })()

  const files: ImportedFile[] = []
  const skipped: string[] = []
  for (const entry of entries) {
    const path = commonPrefix ? entry.name.slice(commonPrefix.length) : entry.name
    if (!path || isBinaryPath(path) || path.endsWith('.DS_Store')) {
      skipped.push(path || entry.name)
      continue
    }
    try {
      const content = await entry.async('text')
      files.push({ path, content })
    } catch {
      skipped.push(path)
    }
  }
  return buildResultFromFiles(files, skipped)
}

/** 统一入口：根据 File 的类型分派到对应的导入逻辑 */
export async function importSingleOrZipFile(file: File): Promise<ImportResult> {
  if (file.name.toLowerCase().endsWith('.zip')) return importZip(file)
  return importSingleFile(file)
}
