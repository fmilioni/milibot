// Stands in for qemu-img: an "image" is a JSON file {virtualSize, backing, snapshots}.
import fs from 'node:fs'

const [command, ...rest] = process.argv.slice(2)
const GiB = 1024 ** 3
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, image) => fs.writeFileSync(file, JSON.stringify(image))
const size = (text) => Number(text.replace(/G$/, '')) * GiB
const option = (flag) => rest[rest.indexOf(flag) + 1]

switch (command) {
  case 'create': {
    const [file, virtual] = rest.slice(-2)
    const image = { virtualSize: size(virtual), snapshots: [] }
    if (rest.includes('-b')) image.backing = option('-b')
    write(file, image)
    break
  }
  case 'info': {
    const file = rest.at(-1)
    const image = read(file)
    const info = { 'virtual-size': image.virtualSize, snapshots: image.snapshots }
    if (image.backing)
      Object.assign(info, { 'backing-filename': image.backing, 'full-backing-filename': image.backing })
    process.stdout.write(JSON.stringify(info))
    break
  }
  case 'snapshot': {
    const file = rest.at(-1)
    const image = read(file)
    if (rest.includes('-c')) {
      const name = option('-c')
      image.snapshots.push({ id: String(image.snapshots.length + 1), name, 'date-sec': 1_750_000_000 })
    }
    if (rest.includes('-d')) image.snapshots = image.snapshots.filter((s) => s.name !== option('-d'))
    write(file, image)
    break
  }
  case 'resize': {
    const [file, virtual] = rest.slice(-2)
    write(file, { ...read(file), virtualSize: size(virtual) })
    break
  }
  default:
    process.stderr.write(`fake qemu-img: unsupported ${command}\n`)
    process.exit(1)
}
