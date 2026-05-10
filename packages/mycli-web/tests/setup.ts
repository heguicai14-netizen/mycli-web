import 'fake-indexeddb/auto'
import { installChromeMock } from './mocks/chrome'
import { beforeEach } from 'vitest'

beforeEach(() => {
  installChromeMock()
})
