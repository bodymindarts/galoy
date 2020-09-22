const lnService = require('ln-service');
import { createHash, randomBytes } from "crypto";
import moment from "moment";
import { disposer } from "./lock";
import { InvoiceUser, MainBook, Transaction } from "./mongodb";
import { sendInvoicePaidNotification } from "./notification";
import { IAddInvoiceInternalRequest, ILightningTransaction, IPaymentRequest } from "./types";
import { addCurrentValueToMetadata, getAuth, logger, measureTime, timeout } from "./utils";
import { customerPath } from "./wallet";

const util = require('util')

const using = require('bluebird').using

const TIMEOUT_PAYMENT = process.env.NETWORK !== "regtest" ? 45000 : 3000

const FEECAP = 0.02 // = 2%
const FEEMIN = 10 // sats

export type ITxType = "invoice" | "payment" | "onchain_receipt" | "onchain_payment" | "on_us"
export type payInvoiceResult = "success" | "failed" | "pending"

export const LightningMixin = (superclass) => class extends superclass {
  lnd = lnService.authenticatedLndGrpc(getAuth()).lnd
  nodePubKey: string | null = null

  constructor(...args) {
    super(...args)
  }

  async getNodePubkey() {
    this.nodePubKey = this.nodePubKey ?? (await lnService.getWalletInfo({ lnd: this.lnd })).public_key
    return this.nodePubKey
  }

  async updatePending() {
    await this.updatePendingInvoices()
    await this.updatePendingPayment()
  }

  async getBalance() {
    await this.updatePending()
    return super.getBalance()
  }

  async getRawTransactions() {
    await this.updatePending()

    const { results } = await MainBook.ledger({
      currency: this.currency,
      account: this.accountPath,
      // start_date: startDate,
      // end_date: endDate
    })

    return results
  }

  async getTransactions(): Promise<Array<ILightningTransaction>> {
    const rawTransactions = await this.getRawTransactions()

    const results_processed = rawTransactions.map(item => ({
      created_at: moment(item.timestamp).unix(),
      amount: item.debit - item.credit,
      sat: item.sat,
      usd: item.usd,
      description: item.memo || item.type, // TODO remove `|| item.type` once users have upgraded
      hash: item.hash,
      fee: item.fee,
      // destination: TODO
      type: item.type,
      pending: item.pending,
      id: item._id,
      currency: item.currency
    }))

    return results_processed
  }

  async addInvoiceInternal({ sats, usd, currency, memo }: IAddInvoiceInternalRequest): Promise<string> {
    let request, id

    try {
      const result = await lnService.createInvoice({
        lnd: this.lnd,
        tokens: sats,
        description: memo,
      })
      request = result.request
      id = result.id
    } catch (err) {
      logger.error({err}, "impossible to create the invoice")
    }

    try {
      const result = await new InvoiceUser({
        _id: id,
        uid: this.uid,
        pending: true,
        usd,
        currency,
      }).save()
    } catch (err) {
      // FIXME if the mongodb connection has not been instanciated
      // this fails silently
      throw Error(`internal: error storing invoice to db ${util.inspect({ err })}`)
    }

    return request
  }

  async validate(params: IPaymentRequest) {

    const keySendPreimageType = '5482373484';
    const preimageByteLength = 32;

    let pushPayment = false
    let tokens
    let destination, id, description
    let routeHint = []
    let messages: Object[] = []
    
    if (params.invoice) {
      // TODO replace this with bolt11 utils library
      ({ id, tokens, destination, description, routes: routeHint } = await lnService.decodePaymentRequest({ lnd: this.lnd, request: params.invoice }))

      if (!!params.amount && tokens !== 0) {
        throw Error('Invoice contains non-zero amount, but amount was also passed separately')
      }
    } else {
      if (!params.destination) {
        throw Error('Pay requires either invoice or destination to be specified')
      }

      pushPayment = true
      destination = params.destination

      const preimage = randomBytes(preimageByteLength);
      id = createHash('sha256').update(preimage).digest().toString('hex');
      const secret = preimage.toString('hex');
      messages = [{ type: keySendPreimageType, value: secret }]
    }

    if (!params.amount && tokens === 0) {
      throw Error('Invoice is a zero-amount invoice, or pushPayment is being used, but no amount was passed separately')
    }

    tokens = !!tokens ? tokens : params.amount

    return { tokens, destination, pushPayment, id, routeHint, description, messages}
  }

  async pay(params: IPaymentRequest): Promise<payInvoiceResult | Error> {

    const { tokens, destination, pushPayment, id, routeHint, description, messages } = await this.validate(params)

    let fee
    let route, routes
    let payeeUid

    const balance = await this.getBalance()

    return await using(disposer(this.uid), async (lock) => {

      if (destination === await this.getNodePubkey()) {
        if (pushPayment) {
          // TODO: if (dest == user) throw error
          //TODO: push payment on-us use case implementation
        } else {
          const existingInvoice = await InvoiceUser.findOne({ _id: id, pending: true })
          if (!existingInvoice) {
            throw Error('User tried to pay invoice destined to us, but it was already paid or does not exist')
            // FIXME: Using == here because === returns false even for same uids
          } else if (existingInvoice.uid == this.uid) {
            throw Error(`User ${this.uid} tried to pay their own invoice (invoice belong to: ${existingInvoice.uid})`)
          }
          payeeUid = existingInvoice.uid
        }

        if (balance < tokens) {
          throw Error(`cancelled: balance is too low. have: ${balance} sats, need ${tokens}`)
        }

        {
          const sats = tokens
          const metadata = { currency: this.currency, hash: id, type: "on_us", pending: false }
          await addCurrentValueToMetadata(metadata, {sats, fee: 0})

          // TODO XXX FIXME:
          // manage the case where a user in USD tries to pay another used in BTC with an onUS transaction

          await MainBook.entry(description)
            .credit(this.accountPath, sats, metadata)
            .debit(customerPath(payeeUid), sats, metadata)
            .commit()
        }

        await sendInvoicePaidNotification({amount: tokens, uid: payeeUid, hash: id})
        await InvoiceUser.findOneAndUpdate({ _id: id }, { pending: false })
        await lnService.cancelHodlInvoice({ lnd: this.lnd, id })
        return "success"
      }

      // TODO add private route from invoice

      try {
        ({ routes } = await lnService.getRoutes({ destination, lnd: this.lnd, tokens, routes: routeHint }));

        if (routes.length === 0) {
          logger.warn("there is no potential route for payment to %o from user %o", destination, this.uid)
          throw Error(`there is no potential route for this payment`)
        }

        logger.info({ routes }, "successfully found routes for payment to %o from user %o", destination, this.uid)
      } catch (err) {
        logger.error({err}, "error getting route")
        throw new Error(err)
      }

      for (const potentialRoute of routes) {
        const probePromise = lnService.probe({ lnd: this.lnd, routes: [potentialRoute] })
        const [probeResult, timeElapsedms] = await measureTime(probePromise)
        logger.info({ probeResult }, `probe took ${timeElapsedms} ms`)
        if (
          probeResult.generic_failures.length == 0 &&
          probeResult.stuck.length == 0 &&
          probeResult.temporary_failures.length == 0 &&
          probeResult.successes.length > 0
        ) {
          route = probeResult.route
          break
        }
      }

      if (!route) {
        logger.warn("there is no payable route for payment to %o from user %o", destination, this.uid)
        throw Error(`there is no payable route for this payment`)
      }

      logger.info({ route }, "successfully found payable route for payment to %o from user %o", destination, this.uid)

      // we are confident enough that there is a possible payment route. let's move forward

      fee = route.safe_fee

      if (fee > FEECAP * tokens && fee > FEEMIN) {
        throw Error(`cancelled: fee exceeds ${FEECAP * 100} percent of token amount`)
      }

      if (balance < tokens + fee) {
        throw Error(`cancelled: balance is too low. have: ${balance} sats, need ${tokens + fee}`)
      }

      if (pushPayment) {
        route.messages = messages
      }

      // reduce balance from customer first

      let entry 

      {
        const sats = tokens + fee

        const metadata = { currency: this.currency, hash: id, type: "payment", pending: true, fee }
        await addCurrentValueToMetadata(metadata, {sats, fee})

        entry = await MainBook.entry(description)
          .debit('Assets:Reserve:Lightning', sats, metadata)
          .credit(this.accountPath, sats, metadata)
          .commit()
      }

      // there is 3 scenarios for a payment.
      // 1/ payment succeed is less than TIMEOUT_PAYMENT
      // 2/ the payment fails. we are reverting it. this including voiding prior transaction
      // 3/ payment is still pending after TIMEOUT_PAYMENT.
      // we are timing out the request for UX purpose, so that the client can show the payment is pending
      // even if the payment is still ongoing from lnd.
      // to clean pending payments, another cron-job loop will run in the background.

      try {

        // Fixme: seems to be leaking if it timeout.
        const promise = lnService.payViaRoutes({ lnd: this.lnd, routes: [route], id })

        await Promise.race([promise, timeout(TIMEOUT_PAYMENT, 'Timeout')])
        // FIXME
        // return this.payDetail({
        //     pubkey: details.destination,
        //     hash: details.id,
        //     amount: details.tokens,
        //     routes: details.routes
        // })

        // console.log({result})

      } catch (err) {

        logger.warn({ err, message: err.message, errorCode: err[1] },
          `payment "error" to %o from user %o`, destination, this.uid)

        if (err.message === "Timeout") {
          return "pending"
          // pending in-flight payment are being handled in a cron-like job
        }

        try {
          await Transaction.updateMany({ hash: id }, { pending: false, error: err[1] })
          await MainBook.void(entry._id, err[1])
        } catch (err_db) {
          const err_message = `error canceling payment entry ${util.inspect({ err_db })}`
          console.error(err_message)
          throw Error(`internal ${err_message}`)
        }

        throw Error(`internal error paying invoice ${util.inspect({ err }, false, Infinity)}`)
      }

      // success
      await Transaction.updateMany({ hash: id }, { pending: false })
      return "success"

    })
  }

  // TODO manage the error case properly. right now there is a mix of string being return
  // or error being thrown. Not sure how this is handled by GraphQL

  async updatePendingPayment() {

    const payments = await Transaction.find({ account_path: this.accountPathMedici, type: "payment", pending: true })

    if (payments === []) {
      return
    }

    return await using(disposer(this.uid), async (lock) => {

      for (const payment of payments) {

        let result
        try {
          result = await lnService.getPayment({ lnd: this.lnd, id: payment.hash })
        } catch (err) {
          throw Error('issue fetching payment: ' + err.toString())
        }

        if (result.is_confirmed) {
          // success
          payment.pending = false
          payment.save()
        }

        if (result.is_failed) {
          try {
            payment.pending = false
            await payment.save()
            await MainBook.void(payment._journal, "Payment canceled") // JSON.stringify(result.failed
          } catch (err) {
            throw Error(`internal: error canceling payment entry ${util.inspect({ err })}`)
          }
        }
      }

    })
  }

  async updatePendingInvoice({ hash }) {
    let invoice

    try {
      // FIXME we should only be able to look at User invoice, 
      // but might not be a strong problem anyway
      // at least return same error if invoice not from user
      // or invoice doesn't exist. to preserve privacy and prevent DDOS attack.
      invoice = await lnService.getInvoice({ lnd: this.lnd, id: hash })
    } catch (err) {
      throw new Error(`issue fetching invoice: ${util.inspect({ err }, { showHidden: false, depth: Infinity })})`)
    }

    // invoice that are on_us will be cancelled but not confirmed
    // so we need a branch to return true in case the payment 
    // has been managed off lnd.
    if (invoice.is_canceled) {
      // TODO: proper testing
      const result = Transaction.findOne({currency: this.currency, id: hash, type: "on_us", pending: false})
      return !!result

    } else if (invoice.is_confirmed) {

      try {

        const invoiceUser = await InvoiceUser.findOne({ _id: hash, uid: this.uid })

        if (!invoiceUser.pending) {
          // invoice has already been processed
          return true
        }

        if (!invoiceUser) {
          throw Error(`no mongodb entry is associated with this invoice ${invoice}`)
        }

        return await using(disposer(this.uid), async (lock) => {

          // TODO: use a transaction here
          // const session = await InvoiceUser.startSession()
          // session.withTransaction(

          // OR: use a an unique index account / hash / voided
          // may still not avoid issue from discrenpency between hash and the books

          invoiceUser.pending = false
          invoiceUser.save()
          
          const sats = invoice.received
          
          const isUSD = invoiceUser.currency === "USD"
          const usd = invoiceUser.usd

          const metadata = { hash, type: "invoice" }
          await addCurrentValueToMetadata(metadata, {usd, sats, fee: 0})

          const brokerAccount = 'Liabilities:Broker'

          const entry = MainBook.entry(invoice.description)
            .credit('Assets:Reserve:Lightning', sats, {...metadata, currency: "BTC"})
            .debit(isUSD ? brokerAccount : this.accountPath, sats, {...metadata, currency: "BTC"})
          
          if(isUSD) {
            entry
              .credit(brokerAccount, usd, {...metadata, currency: "USD"})
              .debit(this.accountPath, usd, {...metadata, currency: "USD"})
          }

          await entry.commit()

          // session.commitTransaction()
          // session.endSession()

          return true
        })

      } catch (err) {
        console.error(err)
        throw new Error(`issue updating invoice: ${err}`)
      }
    }

    return false
  }

  // should be run regularly with a cronjob
  // TODO: move to an "admin/ops" wallet
  async updatePendingInvoices() {

    const invoices = await InvoiceUser.find({ uid: this.uid, pending: true })

    for (const invoice of invoices) {
      await this.updatePendingInvoice({ hash: invoice._id })
    }
  }

}
