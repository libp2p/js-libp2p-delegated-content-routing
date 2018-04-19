/* eslint-env mocha */
'use strict'

const expect = require('chai').expect
const IPFSFactory = require('ipfsd-ctl')
const async = require('async')
const CID = require('cids')
const IPFSApi = require('ipfs-api')

const factory = IPFSFactory.create({ type: 'go' })

const DelegatedContentRouting = require('../src')

describe('DelegatedContentRouting', () => {
  let selfNode
  let selfId

  beforeEach((done) => {
    factory.spawn((err, node) => {
      if (err != null) {
        return done(err)
      }
      selfNode = node

      selfNode.api.id((err, id) => {
        if (err) {
          return done(err)
        }
        selfId = id
        done()
      })
    })
  })

  afterEach(() => {
    selfNode.stop()
  })

  describe('findProviders', () => {
    it('fetches providers on the connected node', function (done) {
      this.timeout(100000)

      let ipfsd

      async.waterfall([
        (cb) => factory.spawn(cb),
        (_ipfsd, cb) => {
          ipfsd = _ipfsd
          const opts = ipfsd.apiAddr.toOptions()
          const routing = new DelegatedContentRouting(selfId, {
            protocol: 'http',
            port: opts.port,
            host: opts.host
          })
          const cid = 'QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv'
          routing.findProviders(cid, cb)
        },
        (providers, cb) => {
          expect(providers).to.have.lengthOf.above(0)

          ipfsd.stop()
          cb()
        }
      ], done)
    })

    // skipping, as otherwise CI will randomly break
    it.skip('fetches providers on the connected node (using ipfs.io)', function (done) {
      this.timeout(100000)

      const routing = new DelegatedContentRouting(selfId)
      const cid = 'QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv'

      async.waterfall([
        (cb) => routing.findProviders(cid, cb),
        (providers, cb) => {
          expect(providers).to.have.lengthOf.above(0)
          cb()
        }
      ], done)
    })
  })

  describe.only('provide', () => {
    it('makes content available on the delegated node', function (done) {
      this.timeout(100000)

      let routing
      let ipfsd
      let cid
      let delegateId
      async.waterfall([
        (cb) => factory.spawn(cb),
        (_ipfsd, cb) => {
          ipfsd = _ipfsd
          const opts = ipfsd.apiAddr.toOptions()
          routing = new DelegatedContentRouting(selfId, {
            protocol: 'http',
            port: opts.port,
            host: opts.host
          })

          selfNode.api.files.add(Buffer.from(`hello-${Math.random()}`), cb)
        },
        (res, cb) => {
          cid = new CID(res[0].hash)
          routing.provide(cid, cb)
        },
        (cb) => ipfsd.api.id(cb),
        (id, cb) => {
          delegateId = id
          ipfsd.api.dht.findprovs(cid.toBaseEncodedString(), {n: 1}, cb)
        },
        (provs, cb) => {
          let providers = []
          provs.filter((res) => Boolean(res.Responses)).forEach((res) => {
            providers = providers.concat(res.Responses)
          })

          const res = providers.find((prov) => prov.ID === delegateId.id)
          expect(res != null).to.be.eql(true)

          ipfsd.stop()
          cb()
        }
      ], done)
    })

    // skipping, as otherwise CI will randomly break
    it.skip('makes content available on the delegated node (using ipfs.io)', function (done) {
      this.timeout(100000)

      const routing = new DelegatedContentRouting(selfId)
      const api = new IPFSApi(routing.api)

      let cid

      async.waterfall([
        (cb) => {
          selfNode.api.files.add(Buffer.from(`hello-${Math.random()}`), cb)
        },
        (res, cb) => {
          cid = new CID(res[0].hash)
          routing.provide(cid, cb)
        },
        (cb) => {
          console.log('findprovs')
          // TODO: this does not return, why?
          api.dht.findprovs(cid.toBaseEncodedString(), {n: 1}, cb)
        },
        (provs, cb) => {
          let providers = []
          provs.filter((res) => Boolean(res.Responses)).forEach((res) => {
            providers = providers.concat(res.Responses)
          })
          console.log('got provs', providers)
          expect(providers).to.have.lengthOf.above(0)

          cb()
        }
      ], done)
    })
  })
})
