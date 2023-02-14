/* eslint-env mocha */

import { expect } from 'aegir/chai'
import { Controller, createFactory } from 'ipfsd-ctl'
import { create, Options, CID as IPFSCID } from 'ipfs-http-client'
import all from 'it-all'
import drain from 'it-drain'
import { isElectronMain, isNode } from 'wherearewe'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { delegatedContentRouting } from '../src/index.js'
// @ts-expect-error no types
import goIpfs from 'go-ipfs'
import pDefer from 'p-defer'
import { CID } from 'multiformats/cid'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { IDResult } from 'ipfs-core-types/src/root'
import type { PeerInfo } from '@libp2p/interface-peer-info'
import { stop } from '@libp2p/interfaces/startable'
import { TimeoutController } from 'timeout-abort-controller'
import type { AbortOptions } from '@libp2p/interfaces'
import { peerIdFromString } from '@libp2p/peer-id'

const factory = createFactory({
  type: 'go',
  ipfsHttpModule: { create },
  ipfsBin: isNode || isElectronMain ? goIpfs.path() : undefined,
  test: true,
  endpoint: 'http://localhost:57483'
})

async function spawnNode (bootstrap: any[] = []): Promise<{ node: Controller, id: IDResult }> {
  const node = await factory.spawn({
    // Lock down the nodes so testing can be deterministic
    ipfsOptions: {
      config: {
        Bootstrap: bootstrap,
        Discovery: {
          MDNS: {
            Enabled: false
          }
        }
      }
    }
  })

  const id = await node.api.id()

  return {
    node,
    id
  }
}

function createIpfsClient (opts: Options): any {
  const client = create(opts)

  return {
    getEndpointConfig: () => client.getEndpointConfig(),
    block: {
      async stat (cid: CID, options?: AbortOptions): Promise<{ cid: CID, size: number }> {
        const result = await client.block.stat(IPFSCID.parse(cid.toString()), options)

        return {
          cid: CID.parse(result.cid.toString()),
          size: result.size
        }
      }
    },
    dht: {
      async * findProvs (cid: CID, options?: AbortOptions): any {
        yield * client.dht.findProvs(IPFSCID.parse(cid.toString()), options)
      },
      async * provide (cid: CID, options?: AbortOptions): any {
        yield * client.dht.provide(IPFSCID.parse(cid.toString()), options)
      },
      async * put (key: string | Uint8Array, value: Uint8Array, options?: AbortOptions) {
        yield * client.dht.put(key, value, options)
      },
      async * get (key: string | Uint8Array, options?: AbortOptions) {
        yield * client.dht.get(key, options)
      }
    }
  }
}

describe('DelegatedContentRouting', function () {
  this.timeout(20 * 1000) // we're spawning daemons, give ci some time

  let selfNode: Controller
  let selfId: PeerId
  let delegateNode: Controller
  let bootstrapNode: Controller
  let bootstrapId: IDResult

  before(async () => {
    // Spawn a "Boostrap" node that doesnt connect to anything
    const bootstrap = await spawnNode()
    bootstrapNode = bootstrap.node
    bootstrapId = bootstrap.id

    // Spawn our local node and bootstrap the bootstrapper node
    const self = await spawnNode(bootstrapId.addresses)
    selfNode = self.node
    selfId = peerIdFromString(self.id.id.toString())

    // Spawn the delegate node and bootstrap the bootstrapper node
    const delegate = await spawnNode(bootstrapId.addresses)
    delegateNode = delegate.node
  })

  after(async () => {
    await factory.clean()
  })

  describe('create', () => {
    it('should require ipfs http client', () => {
      // @ts-expect-error missing parameters
      expect(() => delegatedContentRouting()()).to.throw()
    })

    it('should accept an http api client instance at construction time', () => {
      const client = createIpfsClient({
        protocol: 'http',
        port: 8000,
        host: 'localhost'
      })

      const router = delegatedContentRouting(client)()

      expect(router).to.have.property('client')
        .that.has.property('getEndpointConfig')
        .that.is.a('function')

      expect(client.getEndpointConfig()).to.deep.include({
        protocol: 'http:',
        port: '8000',
        host: 'localhost'
      })
    })
  })

  describe('findProviders', () => {
    const data = uint8ArrayFromString('some data')
    const cid = CID.parse('QmVv4Wz46JaZJeH5PMV4LGbRiiMKEmszPYY3g6fjGnVXBS') // 'some data'

    before('register providers', async () => {
      await Promise.all([
        bootstrapNode.api.add(data),
        selfNode.api.add(data)
      ])
      await Promise.all([
        drain(bootstrapNode.api.dht.provide(IPFSCID.parse(cid.toString()))),
        drain(selfNode.api.dht.provide(IPFSCID.parse(cid.toString())))
      ])
    })

    it('should be able to find providers through the delegate node', async function () {
      const opts = delegateNode.apiAddr.toOptions()

      const routing = delegatedContentRouting(createIpfsClient({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))()

      const providers = await all(routing.findProviders(cid))

      // We should get the bootstrap node as provider
      // The delegate node is not included, because it is handling the requests
      expect(providers.map((p) => p.id.toString())).to.include(bootstrapId.id.toString(), 'Did not include bootstrap node')
      expect(providers.map((p) => p.id.toString())).to.include(selfId.toString(), 'Did not include self node')
    })

    it('should be able to specify a timeout', async () => {
      const opts = delegateNode.apiAddr.toOptions()

      const routing = delegatedContentRouting(createIpfsClient({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))()
      const controller = new TimeoutController(5e3)

      const providers = await all(routing.findProviders(cid, { signal: controller.signal }))

      expect(providers.map((p) => p.id.toString())).to.include(bootstrapId.id.toString(), 'Did not include bootstrap node')

      controller.clear()
    })
  })

  describe('provide', () => {
    it('should be able to register as a content provider to the delegate node', async () => {
      const opts = delegateNode.apiAddr.toOptions()

      const contentRouter = delegatedContentRouting(createIpfsClient({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))()

      const { cid } = await selfNode.api.add(uint8ArrayFromString(`hello-${Math.random()}`))

      await contentRouter.provide(CID.parse(cid.toString()))

      const providers: PeerInfo[] = []

      for await (const event of delegateNode.api.dht.findProvs(cid)) {
        if (event.name === 'PEER_RESPONSE') {
          providers.push(...event.providers)
        }
      }

      // We are hosting the file, validate we're the provider
      expect(providers.map((p) => p.id.toString())).to.include(selfId.toString(), 'Did not include self node')
    })

    it('should provide non-dag-pb nodes via the delegate node', async () => {
      const opts = delegateNode.apiAddr.toOptions()

      const contentRouter = delegatedContentRouting(createIpfsClient({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))()

      const cid = await selfNode.api.dag.put(`hello-${Math.random()}`, {
        storeCodec: 'dag-cbor',
        hashAlg: 'sha2-256'
      })

      await contentRouter.provide(CID.parse(cid.toString()))

      const providers: PeerInfo[] = []

      for await (const event of delegateNode.api.dht.findProvs(cid)) {
        if (event.name === 'PEER_RESPONSE') {
          providers.push(...event.providers)
        }
      }

      // We are hosting the file, validate we're the provider
      expect(providers.map((p) => p.id.toString())).to.include(selfId.toString(), 'Did not include self node')
    })
  })

  describe('get', () => {
    it('should get a value', async () => {
      const opts = delegateNode.apiAddr.toOptions()

      const contentRouter = delegatedContentRouting(createIpfsClient({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))()

      const cid = await selfNode.api.dag.put(`hello-${Math.random()}`, {
        storeCodec: 'dag-cbor',
        hashAlg: 'sha2-256'
      })

      const ipnsRecord = await delegateNode.api.name.publish(cid)
      const key = uint8ArrayFromString(`/ipns/${ipnsRecord.name}`)
      const record = await contentRouter.get(key)

      expect(record).to.be.ok()
    })
  })

  describe('put', () => {
    it('should put a value', async () => {
      const opts = delegateNode.apiAddr.toOptions()

      const contentRouter = delegatedContentRouting(createIpfsClient({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))()

      const cid = await selfNode.api.dag.put(`hello-${Math.random()}`, {
        storeCodec: 'dag-cbor',
        hashAlg: 'sha2-256'
      })

      const ipnsRecord = await selfNode.api.name.publish(cid)
      const key = uint8ArrayFromString(`/ipns/${ipnsRecord.name}`)

      let record: Uint8Array | undefined

      for await (const event of selfNode.api.dht.get(key)) {
        if (event.name === 'VALUE') {
          record = event.value
        }
      }

      if (record == null) {
        throw new Error('Could not load IPNS record')
      }

      await contentRouter.put(key, record)

      expect(await contentRouter.get(key)).to.equalBytes(record)
    })
  })

  describe('stop', () => {
    it('should cancel in-flight requests when stopping', async () => {
      const opts = delegateNode.apiAddr.toOptions()

      const contentRouter = delegatedContentRouting(createIpfsClient({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))()

      const deferred = pDefer<Error>()
      // non-existent CID
      const cid = CID.parse('QmVv4Wz46JaZJeH5PMV4LGbRiiMKEmszPYY3g6fjGnVXBs')

      void drain(contentRouter.findProviders(cid))
        .then(() => {
          deferred.reject(new Error('Did not abort'))
        })
        .catch(err => {
          deferred.resolve(err)
        })

      await stop(contentRouter)
      await expect(deferred.promise).to.eventually.have.property('message').that.matches(/aborted/)
    })
  })
})
