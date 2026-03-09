/** @OnlyCurrentDoc */

const sheetName = 'Sheet1' // Or change to exactly match your sheet tab name!
const scriptProp = PropertiesService.getScriptProperties()

function initialSetup () {
  const activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  scriptProp.setProperty('key', activeSpreadsheet.getId())
}

function doPost (e) {
  const lock = LockService.getScriptLock()
  lock.tryLock(10000)

  try {
    const doc = SpreadsheetApp.openById(scriptProp.getProperty('key'))
    if (!doc) throw new Error("Spreadsheet not found. Did you run initialSetup?");
    
    const sheet = doc.getSheetByName(sheetName)
    if (!sheet) throw new Error("Tab '" + sheetName + "' not found at bottom of sheet.");

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    const nextRow = sheet.getLastRow() + 1

    const newRow = headers.map(function(header) {
      if (header === 'timestamp') return new Date()
      return e.parameter[header] || e.parameter['email'] || ''
    })

    sheet.getRange(nextRow, 1, 1, newRow.length).setValues([newRow])

    return ContentService
      .createTextOutput(JSON.stringify({ 'result': 'success', 'row': nextRow }))
      .setMimeType(ContentService.MimeType.JSON)
  }

  catch (error) {
    // Better error logging to see exactly why it failed
    return ContentService
      .createTextOutput(JSON.stringify({ 'result': 'error', 'message': error.toString() }))
      .setMimeType(ContentService.MimeType.JSON)
  }

  finally {
    lock.releaseLock()
  }
}
