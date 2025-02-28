import { MainBook } from "./mongodb";
import moment from "moment";

import {createObjectCsvStringifier, createObjectCsvWriter} from "csv-writer"

const header = [
  { id: 'voided', title: 'voided' },
  { id: 'approved', title: 'approved' },
  { id: '_id', title: '_id' },
  { id: 'accounts', title: 'accounts' },
  { id: 'credit', title: 'credit' },
  { id: 'debit', title: 'debit' },
  { id: '_journal', title: '_journal' },
  { id: 'book', title: 'book' },
  { id: 'unix', title: 'unix' },
  { id: 'date', title: 'date' },
  { id: 'datetime', title: 'datetime' },
  { id: 'currency', title: 'currency' },
  { id: 'username', title: 'username' },
  { id: 'type', title: 'type' },
  { id: 'hash', title: 'hash' },
  { id: 'txid', title: 'txid' },
  { id: 'fee', title: 'fee' },
  { id: 'feeUsd', title: 'feeUsd' },
  { id: 'sats', title: 'sats' },
  { id: 'usd', title: 'usd' },
  { id: 'memo', title: 'memo' },
  { id: 'memoPayer', title: 'memoPayer' },
  { id: 'meta', title: 'meta' },
  { id: 'pending', title: 'pending' },
]

export class CSVAccountExport {
  entries = []

  getBase64(): string {
    const csvWriter = createObjectCsvStringifier({
      header
    })

    const header_stringify = csvWriter.getHeaderString();
    const records = csvWriter.stringifyRecords(this.entries)

    const str = header_stringify + records

    // create buffer from string
    const binaryData = Buffer.from(str, "utf8");

    // decode buffer as base64
    const base64Data = binaryData.toString("base64");

    return base64Data
  }

  async saveToDisk(): Promise<void> {
    const csvWriter = createObjectCsvWriter({
      path: 'export_accounts.csv',
      header
    });

    await csvWriter.writeRecords(this.entries)
    console.log("saving complete")
  }

  async addAccount({account}): Promise<void> {
    let transactions

    ({ results: transactions } = await MainBook.ledger({
      account
    }))

    transactions.forEach(tx => tx = tx.toObject())
    transactions.forEach(tx => tx.meta = JSON.stringify(tx.meta))
    transactions.forEach(tx => tx.unix = moment(tx.datetime).unix())
    transactions.forEach(tx => tx.date = moment(tx.datetime).format('L'))

    // @ts-ignore
    this.entries.push(...transactions);
  }
  
}