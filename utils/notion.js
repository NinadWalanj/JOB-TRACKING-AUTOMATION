const { Client } = require("@notionhq/client");
require("dotenv").config();

const notion = new Client({ auth: process.env.NOTION_SECRET });
const databaseId = process.env.NOTION_DATABASE_ID;

async function addToNotion({
  company,
  subject,
  date,
  referral,
  body,
  status,
  gmailMessageId,
}) {
  try {
    // 1. Check for existing entry with the same Gmail Message ID
    const existing = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "Gmail Message ID",
        rich_text: {
          equals: gmailMessageId,
        },
      },
    });

    if (existing.results.length > 0) {
      console.log(`📭 Skipping duplicate: ${gmailMessageId}`);
      return;
    }

    // 2. Create new entry
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        "Company Name": {
          title: [{ text: { content: company } }],
        },
        "Email Subject": {
          rich_text: [{ text: { content: subject.slice(0, 2000) } }],
        },
        "Date received": {
          date: {
            start: new Date(date).toISOString(),
          },
        },
        "Referral?": {
          rich_text: [{ text: { content: referral } }],
        },
        "Email Body": {
          rich_text: [{ text: { content: body.slice(0, 2000) } }],
        },
        Status: {
          status: {
            name: status,
          },
        },
        "Gmail Message ID": {
          rich_text: [{ text: { content: gmailMessageId } }],
        },
      },
    });

    console.log(`✅ Added to Notion: ${company}`);
  } catch (err) {
    console.error("❌ Notion insert failed:", err.message);
  }
}

module.exports = { addToNotion };
