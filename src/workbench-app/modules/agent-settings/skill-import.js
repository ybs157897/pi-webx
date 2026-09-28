const MAX_FILES_PER_SKILL = 200
const MAX_TOTAL_BYTES = 4_000_000

function cleanPath(path) {
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('所选文件夹包含无效路径。')
  return parts.join('/')
}

function frontmatterValue(content, field) {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1] || ''
  return new RegExp(`^${field}:\\s*["']?([^\\n"']+)["']?\\s*$`, 'm').exec(frontmatter)?.[1]?.trim() || ''
}

function base64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

export async function collectSkillImports(fileList) {
  const entries = Array.from(fileList, file => ({ file, path: cleanPath(file.webkitRelativePath || file.name) }))
  const roots = entries.filter(entry => entry.path.endsWith('/SKILL.md') || entry.path === 'SKILL.md')
    .map(entry => entry.path.slice(0, -'SKILL.md'.length))
    .sort((a, b) => b.length - a.length)
  if (!roots.length) throw new Error('未找到 SKILL.md。请选择包含 Skill 的文件夹。')
  const groups = new Map(roots.map(root => [root, []]))
  for (const entry of entries) {
    const root = roots.find(candidate => entry.path.startsWith(candidate))
    if (root) groups.get(root).push({ file: entry.file, path: entry.path.slice(root.length) })
  }
  const totalBytes = Array.from(groups.values()).flat().reduce((sum, item) => sum + item.file.size, 0)
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('所选 Skill 合计超过 4 MB，请缩小导入范围。')
  const result = []
  for (const [root, files] of groups) {
    if (files.length > MAX_FILES_PER_SKILL) throw new Error('单个 Skill 最多可导入 200 个文件。')
    const skillFile = files.find(item => item.path === 'SKILL.md')
    const skillText = await skillFile.file.text()
    const name = frontmatterValue(skillText, 'name')
    const description = frontmatterValue(skillText, 'description')
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || !description)
      throw new Error(`Skill 文件夹「${root.split('/').filter(Boolean).at(-1) || '当前'}」需要有效的 name 和 description。`)
    result.push({ name, description, files: await Promise.all(files.map(async item => ({
      path: item.path, content: base64(new Uint8Array(await item.file.arrayBuffer())),
    }))) })
  }
  if (new Set(result.map(item => item.name)).size !== result.length)
    throw new Error('所选文件夹包含重名 Skill，请分别导入。')
  return result.sort((a, b) => a.name.localeCompare(b.name))
}
