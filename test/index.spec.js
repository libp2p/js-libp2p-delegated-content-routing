/* eslint-env mocha */
'use strict'

const expect = require('chai').expect
const IPFSFactory = require('ipfsd-ctl')
const async = require('async')

const DelegatedContentRouting = require('../src')

describe('DelegatedContentRouting', () => {
  describe('findProviders', () => {
    it('fetches providers on the connected node', function (done) {
      this.timeout(100000)

      const factory = IPFSFactory.create({ type: 'go' })

      async.waterfall([
        (cb) => factory.spawn(cb),
        (ipfsd, cb) => {
          const opts = ipfsd.apiAddr.toOptions()
          const routing = new DelegatedContentRouting({
            protocol: 'http',
            port: opts.port,
            host: opts.host
          })
          const cid = 'QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv'
          routing.findProviders(cid, cb)
        },
        (providers, cb) => {
          expect(providers).to.have.lengthOf.above(0)
          cb()
        }
      ], done)
    })

    // skipping, as otherwise CI will randomly break
    it.skip('fetches providers on the connected node (using ipfs.io)', function (done) {
      this.timeout(100000)

      const routing = new DelegatedContentRouting()
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
})
