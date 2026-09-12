/** Re-reads a stored media message with the current pipeline. */
import { logger } from '../core/logger.js'
import { connectMinio, getMedia } from '../db/minio.js'
import { closeMongo, connectMongo } from '../db/mongo.js'
import { messageRepository } from '../repositories/index.js'
import { visionService } from '../services/vision.service.js'
import { parseCourseList } from '../utils/courses.js'
import { courseDisplay } from '../utils/courses.js'

const id = process.argv[2]!
await connectMongo()
await connectMinio()

const m = await messageRepository.findById(id)
if (!m?.mediaKey) {
  console.log('no media')
  process.exit(1)
}

const text = await visionService.readImage(await getMedia(m.mediaKey), m.mimeType)
console.log('--- OCR ---\n' + (text ?? '(nothing read)'))

const combined = [m.caption, text].filter(Boolean).join('\n')
const courses = parseCourseList(combined)
console.log('\n--- courses found: ' + courses.length + ' ---')
console.log(courses.map((k) => `  ${courseDisplay(k)}  (key ${k})`).join('\n'))

await closeMongo()
