import { logger } from '@libp2p/logger'
import drain from 'it-drain'
import PQueue from 'p-queue'
import defer from 'p-defer'
import errCode from 'err-code'
import anySignal from 'any-signal'
import type { AbortOptions } from 'ipfs-core-types/src/utils'
import type { ContentRouting } from '@libp2p/interface-content-routing'
import type { PeerInfo } from '@libp2p/interface-peer-info'
import type { Startable } from '@libp2p/interfaces/startable'
import type { CID } from 'multiformats/cid'
import type { PeerId } from '@libp2p/interface-peer-id'

const log = logger('libp2p:delegated-content-routing')

const DEFAULT_TIMEOUT = 30e3 // 30 second default
const CONCURRENT_HTTP_REQUESTS = 4
const CONCURRENT_HTTP_REFS_REQUESTS = 2

export interface HTTPClientExtraOptions {
  headers?: Record<string, string>
  searchParams?: URLSearchParams
}

export enum EventTypes {
  SENDING_QUERY = 0,
  PEER_RESPONSE,
  FINAL_PEER,
  QUERY_ERROR,
  PROVIDER,
  VALUE,
  ADDING_PEER,
  DIALING_PEER
}

/**
 * The types of messages set/received during DHT queries
 */
export enum MessageType {
  PUT_VALUE = 0,
  GET_VALUE,
  ADD_PROVIDER,
  GET_PROVIDERS,
  FIND_NODE,
  PING
}

export type MessageName = keyof typeof MessageType

export interface DHTRecord {
  key: Uint8Array
  value: Uint8Array
  timeReceived?: Date
}

export interface SendingQueryEvent {
  type: EventTypes.SENDING_QUERY
  name: 'SENDING_QUERY'
}

export interface PeerResponseEvent {
  from: PeerId
  type: EventTypes.PEER_RESPONSE
  name: 'PEER_RESPONSE'
  messageType: MessageType
  messageName: MessageName
  providers: PeerInfo[]
  closer: PeerInfo[]
  record?: DHTRecord
}

export interface FinalPeerEvent {
  peer: PeerInfo
  type: EventTypes.FINAL_PEER
  name: 'FINAL_PEER'
}

export interface QueryErrorEvent {
  type: EventTypes.QUERY_ERROR
  name: 'QUERY_ERROR'
  error: Error
}

export interface ProviderEvent {
  type: EventTypes.PROVIDER
  name: 'PROVIDER'
  providers: PeerInfo[]
}

export interface ValueEvent {
  type: EventTypes.VALUE
  name: 'VALUE'
  value: Uint8Array
}

export interface AddingPeerEvent {
  type: EventTypes.ADDING_PEER
  name: 'ADDING_PEER'
  peer: PeerId
}

export interface DialingPeerEvent {
  peer: PeerId
  type: EventTypes.DIALING_PEER
  name: 'DIALING_PEER'
}

export type QueryEvent = SendingQueryEvent | PeerResponseEvent | FinalPeerEvent | QueryErrorEvent | ProviderEvent | ValueEvent | AddingPeerEvent | DialingPeerEvent

export interface DHTProvideOptions extends AbortOptions {
  recursive?: boolean
}

export interface StatResult {
  cid: CID
  size: number
}

export interface Delegate {
  getEndpointConfig: () => { protocol: string, host: string, port: string }

  block: {
    stat: (cid: CID, options?: AbortOptions) => Promise<StatResult>
  }

  dht: {
    findProvs: (cid: CID, options?: HTTPClientExtraOptions & AbortOptions) => AsyncIterable<QueryEvent>
    provide: (cid: CID, options?: HTTPClientExtraOptions & DHTProvideOptions) => AsyncIterable<QueryEvent>
    put: (key: string | Uint8Array, value: Uint8Array, options?: HTTPClientExtraOptions & AbortOptions) => AsyncIterable<QueryEvent>
    get: (key: string | Uint8Array, options?: HTTPClientExtraOptions & AbortOptions) => AsyncIterable<QueryEvent>
  }
}

/**
 * An implementation of content routing, using a delegated peer
 */
class DelegatedContentRouting implements ContentRouting, Startable {
  private readonly client: Delegate
  private readonly httpQueue: PQueue
  private readonly httpQueueRefs: PQueue
  private started: boolean
  private abortController: AbortController

  /**
   * Create a new DelegatedContentRouting instance
   */
  constructor (client: Delegate) {
    if (client == null) {
      throw new Error('missing ipfs http client')
    }

    this.client = client
    this.started = false
    this.abortController = new AbortController()

    // limit concurrency to avoid request flood in web browser
    // https://github.com/libp2p/js-libp2p-delegated-content-routing/issues/12
    this.httpQueue = new PQueue({
      concurrency: CONCURRENT_HTTP_REQUESTS
    })
    // sometimes refs requests take long time, they need separate queue
    // to not suffocate regular business
    this.httpQueueRefs = new PQueue({
      concurrency: CONCURRENT_HTTP_REFS_REQUESTS
    })

    const {
      protocol,
      host,
      port
    } = client.getEndpointConfig()

    log(`enabled DelegatedContentRouting via ${protocol}://${host}:${port}`)
  }

  isStarted (): boolean {
    return this.started
  }

  start (): void {
    this.started = true
  }

  stop (): void {
    this.httpQueue.clear()
    this.httpQueueRefs.clear()
    this.abortController.abort()
    this.abortController = new AbortController()
    this.started = false
  }

  /**
   * Search the dht for providers of the given CID.
   *
   * - call `findProviders` on the delegated node.
   */
  async * findProviders (key: CID, options: HTTPClientExtraOptions & AbortOptions = {}): AsyncIterable<PeerInfo> {
    log('findProviders starts: %c', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT
    options.signal = anySignal([this.abortController.signal].concat((options.signal != null) ? [options.signal] : []))

    const onStart = defer()
    const onFinish = defer()

    void this.httpQueue.add(async () => {
      onStart.resolve()
      return await onFinish.promise
    })

    try {
      await onStart.promise

      for await (const event of this.client.dht.findProvs(key, options)) {
        if (event.name === 'PROVIDER') {
          yield * event.providers.map(prov => {
            const peerInfo: PeerInfo = {
              id: prov.id,
              protocols: [],
              multiaddrs: prov.multiaddrs
            }

            return peerInfo
          })
        }
      }
    } catch (err) {
      log.error('findProviders errored:', err)
      throw err
    } finally {
      onFinish.resolve()
      log('findProviders finished: %c', key)
    }
  }

  /**
   * Announce to the network that the delegated node can provide the given key.
   *
   * Currently this uses the following hack
   * - delegate is one of bootstrap nodes, so we are always connected to it
   * - call block stat on the delegated node, so it fetches the content
   * - call dht provide with the passed cid
   *
   * N.B. this must be called for every block in the dag you want provided otherwise
   * the delegate will only be able to supply the root block of the dag when asked
   * for the data by an interested peer.
   */
  async provide (key: CID, options: HTTPClientExtraOptions & AbortOptions = {}): Promise<void> {
    log('provide starts: %c', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT
    options.signal = anySignal([this.abortController.signal].concat((options.signal != null) ? [options.signal] : []))

    await this.httpQueueRefs.add(async () => {
      await this.client.block.stat(key, options)
      await drain(this.client.dht.provide(key, options))
    })
    log('provide finished: %c', key)
  }

  /**
   * Stores a value in the backing key/value store of the delegated content router.
   * This may fail if the delegated node's content routing implementation does not
   * use a key/value store, or if the delegated operation fails.
   */
  async put (key: Uint8Array, value: Uint8Array, options: HTTPClientExtraOptions & AbortOptions = {}): Promise<void> {
    log('put value start: %b', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT
    options.signal = anySignal([this.abortController.signal].concat((options.signal != null) ? [options.signal] : []))

    await this.httpQueue.add(async () => {
      await drain(this.client.dht.put(key, value, options))
    })

    log('put value finished: %b', key)
  }

  /**
   * Fetches an value from the backing key/value store of the delegated content router.
   * This may fail if the delegated node's content routing implementation does not
   * use a key/value store, or if the delegated operation fails.
   */
  async get (key: Uint8Array, options: HTTPClientExtraOptions & AbortOptions = {}): Promise<Uint8Array> {
    log('get value start: %b', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT
    options.signal = anySignal([this.abortController.signal].concat((options.signal != null) ? [options.signal] : []))

    const value = await this.httpQueue.add(async () => {
      for await (const event of this.client.dht.get(key, options)) {
        if (event.name === 'VALUE') {
          log('get value finished: %b', key)
          return event.value
        }
      }

      throw errCode(new Error('Not found'), 'ERR_NOT_FOUND')
    })

    if (value === undefined) {
      throw errCode(new Error('Not found'), 'ERR_NOT_FOUND')
    } else {
      return value
    }
  }
}

export function delegatedContentRouting (client: Delegate): (components?: any) => ContentRouting {
  return () => new DelegatedContentRouting(client)
}
