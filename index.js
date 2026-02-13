'use strict';

/*==================================
 BASIC REQUIRE
====================================*/
const line = require('@line/bot-sdk');
const express = require('express');
const path = require('path');
const HTMLParser = require('node-html-parser');
const https = require('https');
const { getAudioDurationInSeconds } = require('get-audio-duration');
const fs = require('fs');

// --- 新增：Google Sheets 初始化套件 ---
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const config = {
  channelAccessToken: process.env.token,
  channelSecret: process.env.secret,
};

/*==================================
 GOOGLE SHEETS 授權設定
====================================*/
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
 key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '') : '',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

/*==================================
 CUSTOM REQUIRE AND INIT
====================================*/
const client = new line.Client(config);
const app = express();
const words = require('./words.json');
const words_advance = require('./words-advance.json');
let echo = { type: 'text', text: '請從選單進行操作 ⬇️' };

const dirs = ['./user_question', './user_words', './users'];
dirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

/*==================================
 APP REQUEST ACTIONS
====================================*/
app.use('/audio/', express.static('./audio/'));
app.use('/video/', express.static('./video/'));

app.get('/', (req, res) => {
  let html = `<html><head><title>高中7000單</title><script>window.location = "https://lin.ee/BH9lDv7";</script></head><body style="text-align:center"><h1>自動跳轉中⋯⋯</h1></body></html>`;
  res.send(html);
});

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

/*==================================
 APP ROUTER
====================================*/
function handleEvent(event) {
  if (event.type === 'message') {
    return handleMessageEvent(event);
  } else if (event.type === 'postback') {
    return handlePostbackEvent(event);
  } else {
    return Promise.resolve(null);
  }
}

function handleMessageEvent(event) {
  switch (event.message.text) {
    case '開始測驗':
      return client.replyMessage(event.replyToken, [createQuestionType()]);
    case '我的字庫':
      return createUserCollection(event);
    case '得分':
      return handleUserPoints(event); 
    default:
      let user = event.source.userId;
      let qPath = __dirname + `/user_question/${user}.json`;
      if (fs.existsSync(qPath)) {
        return handleAudioAnswer(event);
      } else {
        return client.replyMessage(event.replyToken, echo);
      }
  }
}

function handlePostbackEvent(event) {
  const postback_result = handleUrlParams(event.postback.data);
  switch (postback_result.type) {
    case 'question_type':
      return client.replyMessage(event.replyToken, [createQuestion(event, postback_result.question_type)]);
    case 'answer':
      let isCorrect = handleAnswer(event.postback.data);
      if (isCorrect) {
        updateUserPoints(event); 
        return client.replyMessage(event.replyToken, moreQuestion(postback_result.question_type, postback_result.wid, true));
      } else {
        updateUserWrongAnswer(event); 
        return client.replyMessage(event.replyToken, moreQuestion(postback_result.question_type, postback_result.wid, false));
      }
    case 'play_pronounce':
      return playPronounce(event, postback_result.wid);
    case 'more_question':
      return client.replyMessage(event.replyToken, [createQuestion(event, postback_result.question_type, postback_result.wid)]);
    case 'more_test':
      return client.replyMessage(event.replyToken, [createQuestion(event, postback_result.question_type)]);
    case 'add_to_collection':
      return addToUserCollection(event, postback_result.wid);
    case 'delete_from_my_collection':
      return deleteFromMyCollection(event, postback_result.wid);
    case 'check_my_collection':
      return createUserCollection(event);
    case 'check_word':
      return checkWord(event, postback_result.wid);
    default:
      return client.replyMessage(event.replyToken, echo);
  }
}

/*==================================
 GOOGLE SHEETS 關鍵函數 (雲端化核心)
====================================*/

async function handleUserPoints(event) {
  const userId = event.source.userId;
  console.log('正在嘗試幫用戶加分，ID:', userId);
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    const userRow = rows.find(r => r.get('userId') === userId);

    if (userRow) {
      console.log('找到用戶，目前分數:', userRow.get('point'));
      const userData = {
        user: userId,
        point: parseInt(userRow.get('point')) || 0,
        wrong_answer: parseInt(userRow.get('wrong_answer')) || 0
      };
      userRow.set('point', (parseInt(userRow.get('point')) || 0) + 1);
      await userRow.save();
      console.log('分數更新成功！');
      return client.replyMessage(event.replyToken, createPointMessage(userData));
    } else {
      console.log('找不到用戶，建立新欄位');
      await sheet.addRow({ userId: userId, point: 0, wrong_answer: 0 });
      return client.replyMessage(event.replyToken, { type: 'text', text: "找不到用戶，開始挑戰吧" });
    }
  } catch (err) { console.error('Sheet Read Error:', err); }
}

async function updateUserPoints(event) {
  const userId = event.source.userId;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    let userRow = rows.find(r => r.get('userId') === userId);

    if (userRow) {
      userRow.set('point', (parseInt(userRow.get('point')) || 0) + 1);
      await userRow.save();
    } else {
       await sheet.addRow({ userId: userId, point: 1, wrong_answer: 0 });
    }
  } catch (err) { console.error('Sheet Update Error:', err); }
}

async function updateUserWrongAnswer(event) {
  const userId = event.source.userId;
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    let userRow = rows.find(r => r.get('user') === userId);

    if (userRow) {
      userRow.set('wrong_answer', (parseInt(userRow.get('wrong_answer')) || 0) + 1);
      await userRow.save();
    } else {
      await sheet.addRow({ user: userId, point: 0, wrong_answer: 1 });
    }
  } catch (err) { console.error('Sheet Update Error:', err); }
}

/*==================================
 APP FUNCTIONS (原本 600 行的所有邏輯都在這)
====================================*/

function createQuestionType() {
  return {
    "type": "flex", "altText": "考試開始，不要作弊！",
    "contents": {
      "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md",
        "contents": [
          { "type": "button", "action": { "type": "postback", "label": "英文出題", "data": "wid=&type=question_type&question_type=english&content=english" }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "中文出題", "data": "wid=&type=question_type&question_type=chinese&content=chinese" }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "發音出題", "data": "wid=&type=question_type&question_type=audio&content=audio" }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "英文出題 (高階)", "data": "wid=&type=question_type&question_type=english_advance&content=english_advance" }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "中文出題 (高階)", "data": "wid=&type=question_type&question_type=chinese_advance&content=chinese_advance" }, "style": "secondary" }
        ]
      }
    }
  };
}

function createQuestion(event, question_type, current_wid = null) {
  if (question_type == 'audio') return createAudioQuestion(event, question_type, current_wid);
  let new_words = (question_type == 'english_advance' || question_type == 'chinese_advance') ? words_advance : words;
  if (current_wid !== null) {
    let index = getObjectItemIndex(words, current_wid);
    if (index !== -1) new_words = removeByIndex(new_words, index);
  }
  let w = new_words[Math.floor(Math.random() * new_words.length)];
  let contents = [];
  let question = (question_type == 'english' || question_type == 'english_advance') ? (w.word).replace(/(\w+)\s(\(\w+\.\))/g, "$1") : w.translate;
  contents.push({ "type": "text", "text": `${question}\n`, "size": "xxl", "wrap": true });
  let answers = createAnswers(question_type, w.id);
  answers.push(w);
  answers.sort(() => Math.random() - 0.5);
  for (let i = 0; i < answers.length; i++) {
    let temp_answer = (question_type == 'english' || question_type == 'english_advance') ? answers[i].translate : answers[i].word;
    contents.push({ "type": "button", "action": { "type": "postback", "label": (temp_answer).replace(/(\w+)\s(\(\w+\.\))/g, "$1"), "data": `wid=${w.id}&type=answer&question_type=${question_type}&content=${temp_answer}` }, "style": "secondary" });
  }
  return { "type": "flex", "altText": "考試開始，不要作弊！", "contents": { "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": contents } } };
}

function createAudioQuestion(event, question_type, current_wid = null) {
  let new_words = words;
  if (current_wid !== null) {
    let index = getObjectItemIndex(words, current_wid);
    if (index !== -1) new_words = removeByIndex(new_words, index);
  }
  let w = new_words[Math.floor(Math.random() * new_words.length)];
  let user = event.source.userId;
  let path = __dirname + `/user_question/${user}.json`;
  fs.writeFileSync(path, JSON.stringify([w]));
  return { "type": "flex", "altText": "考試開始，不要作弊！", "contents": { "type": "bubble", 
    "hero": { "type": "video", "url": `https://words7000.unlink.men/video/${w.id}.mp4`, "previewUrl": "https://words7000.unlink.men/audio/cover.png", "aspectRatio": "16:9" },
    "body": { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "wrap": true, "text": "請點擊影片聽取音檔\n並輸入答案後送出" }] } } };
}

function createAnswers(question_type, wid, total = 3) {
  let object = [];
  let new_words = (question_type == 'english_advance' || question_type == 'chinese_advance') ? [...words_advance] : [...words];
  let index = getObjectItemIndex(new_words, wid);
  if (index !== -1) new_words.splice(index, 1);
  if (question_type.includes('advance')) total = 5;
  for (let i = 0; i < total; i++) {
    let rand = Math.floor(Math.random() * new_words.length);
    object.push(new_words.splice(rand, 1)[0]);
  }
  return object;
}

function moreQuestion(question_type, wid, answer) {
  let w = words.filter(x => x.id == wid);
  let contents = [];
  contents.push({ "type": "text", "size": "xl", "color": answer ? "#000000" : "#ff0000", "text": answer ? "恭喜、答對了！！！\n" : "❌ 答錯了！\n" });
  contents.push({ "type": "separator" });
  contents.push({ "type": "text", "wrap": true, "text": `${w[0].word}\n翻譯：${w[0].translate}\n` });
  contents.push({ "type": "button", "action": { "type": "postback", "label": "再來一題", "data": `wid=${wid}&type=more_question&question_type=${question_type}&content=再來一題` }, "style": "primary" });
  contents.push({ "type": "button", "action": { "type": "postback", "label": "聽發音", "data": `wid=${wid}&type=play_pronounce&question_type=${question_type}&content=聽發音` }, "style": "secondary" });
  return { "type": "flex", "altText": "再來一題", "contents": { "type": "bubble", 
    "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": contents },
    "footer": { "type": "box", "layout": "vertical", "contents": [{ "type": "separator" }, { "type": "button", "action": { "type": "postback", "label": "加入字庫", "data": `wid=${wid}&type=add_to_collection&content=加入字庫` } }] } } };
}

function handleAnswer(data) {
  let result = handleUrlParams(data);
  let w = (result.question_type.includes('advance')) ? words_advance.find(x => x.id == result.wid) : words.find(x => x.id == result.wid);
  if (!w) return false;
  if (result.question_type.includes('english')) return result.content == w.translate;
  return result.content == w.word;
}

function handleAudioAnswer(event) {
  let user = event.source.userId;
  let path = __dirname + `/user_question/${user}.json`;
  if (!fs.existsSync(path)) return;
  let user_json = JSON.parse(fs.readFileSync(path));
  let w = user_json[0];
  let answer = w.word.replace(/(\w+)\s.+/g, "$1").replace(/é/g, "e").replace(/[-.\s]/g, "").toLowerCase();
  let user_answer = event.message.text.replace(/[-.\s]/g, "").replace(/é/g, "e").toLowerCase();
  fs.unlinkSync(path);
  if (user_answer == answer) {
    updateUserPoints(event);
    return client.replyMessage(event.replyToken, moreQuestion("audio", w.id, true));
  } else {
    updateUserWrongAnswer(event);
    return client.replyMessage(event.replyToken, moreQuestion("audio", w.id, false));
  }
}

function createUserCollection(event) {
  let user = event.source.userId;
  let path = __dirname + `/user_words/${user}.json`;
  if (!fs.existsSync(path)) return client.replyMessage(event.replyToken, { type: "text", text: "您的字庫裡尚無任何單字" });
  let user_json = JSON.parse(fs.readFileSync(path));
  let user_words = user_json[0].words;
  if (user_words.length == 0) return client.replyMessage(event.replyToken, { type: "text", text: "您的字庫裡尚無任何單字" });
  
  let bubble_content = [];
  let box_content = [];
  for (let i = 0; i < user_words.length; i++) {
    box_content.push({ "type": "box", "layout": "horizontal", "spacing": "md", "contents": [
      { "type": "text", "wrap": true, "flex": 5, "text": `${user_words[i].word}\n${user_words[i].translate}` },
      { "type": "button", "flex": 2, "action": { "type": "postback", "label": "查看", "data": `wid=${user_words[i].id}&type=check_word&content=查看` }, "style": "secondary" }
    ]});
    if ((i + 1) < user_words.length && (i + 1) % 7 != 0) box_content.push({ "type": "separator" });
    if ((i + 1) % 7 == 0 || (i + 1) == user_words.length) {
      bubble_content.push({ "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": box_content } });
      box_content = [];
    }
  }
  return client.replyMessage(event.replyToken, [{ "type": "flex", "altText": "我的字庫", "contents": { "type": "carousel", "contents": bubble_content } }]);
}

function checkWord(event, wid) {
  let w = words.find(x => x.id == wid);
  let word = w.word.replace(/é/g, "e").replace(/[-.\s]/g, "").replace(/(\w+)\s(\(\w+\.?\))/g, "$1");
  if (word == "BBQ") word = "barbecue";
  let url = "https://cdict.info/query/" + encodeURIComponent(word);

  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      let root = HTMLParser.parse(data);
      let word_pa = root.querySelector('.resultbox .dictt')?.innerText.replace(/(國際音標)/g, "\n國際音標") || "";
      let word_info = root.querySelector('.resultbox')?.toString().replace(/<br\s*[\/]?>/g, "\n").replace(/<[^>]+>/g, "") || w.translate;
      if (word_info.includes("找不到相關")) word_info = w.translate;

      let body_contents = [];
      if (word_pa) { body_contents.push({ "type": "text", "color": "#999999", "size": "xs", "wrap": true, "text": word_pa }); body_contents.push({ "type": "separator" }); }
      body_contents.push({ "type": "text", "wrap": true, "text": word_info });

      client.replyMessage(event.replyToken, [{ "type": "flex", "altText": "單字詳解", "contents": { "type": "bubble",
        "header": { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "size": "xl", "text": word }] },
        "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": body_contents },
        "footer": { "type": "box", "layout": "vertical", "contents": [
          { "type": "button", "action": { "type": "postback", "label": "聽發音", "data": `wid=${wid}&type=play_pronounce&content=聽發音` }, "style": "secondary" },
          { "type": "button", "action": { "type": "postback", "label": "從字庫刪除", "data": `wid=${wid}&type=delete_from_my_collection&content=從字庫刪除` } },
          { "type": "separator" },
          { "type": "button", "action": { "type": "postback", "label": "查看字庫", "data": `wid=&type=check_my_collection&content=查看字庫` } }
        ] }
      } }]);
    });
  });
}

function playPronounce(event, wid) {
  let w = words.find(x => x.id == wid);
  getAudioDurationInSeconds(`https://words7000.unlink.men/audio/${w.id}.m4a`).then((duration) => {
    client.replyMessage(event.replyToken, { "type": "audio", "originalContentUrl": `https://words7000.unlink.men/audio/${w.id}.m4a`, "duration": duration * 1000 });
  });
}

function addToUserCollection(event, wid) {
  let user = event.source.userId;
  let path = __dirname + `/user_words/${user}.json`;
  let word = words.find(x => x.id == wid);
  let user_data = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : [{"user": user, "words": []}];
  let user_words = user_data[0].words;
  if (user_words.length >= 70) return client.replyMessage(event.replyToken, { type: "text", text: "你的字庫達上限，請刪減一些單字" });
  if (user_words.find(x => x.id == wid)) return client.replyMessage(event.replyToken, { type: "text", text: "字彙已在您的字庫中！" });
  user_words.push(word);
  fs.writeFileSync(path, JSON.stringify([{"user": user, "words": user_words}]));
  return client.replyMessage(event.replyToken, { type: "text", text: "已加入您的字庫" });
}

function deleteFromMyCollection(event, wid) {
  let user = event.source.userId;
  let path = __dirname + `/user_words/${user}.json`;
  if (!fs.existsSync(path)) return client.replyMessage(event.replyToken, { type: "text", text: "找不到您的字庫資料" });
  let user_data = JSON.parse(fs.readFileSync(path));
  let user_words = user_data[0].words;
  let index = user_words.findIndex(x => x.id == wid);
  if (index !== -1) user_words.splice(index, 1);
  fs.writeFileSync(path, JSON.stringify([{"user": user, "words": user_words}]));
  return client.replyMessage(event.replyToken, [{ "type": "flex", "altText": "刪除成功", "contents": { "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": [{ "type": "text", "size": "lg", "text": "刪除成功！" }, { "type": "button", "action": { "type": "message", "label": "查看我的字庫", "text": "我的字庫" }, "style": "secondary" }] } } }]);
}

function createPointMessage(user_json) {
  let point = user_json.point;
  let wrong_answer = user_json.wrong_answer || 0;
  let score = point - wrong_answer;
  let gold_stars = score >= 2500 ? 5 : score >= 1000 ? 4 : score >= 500 ? 3 : score >= 100 ? 2 : 1;
  let stars = [];
  for (let i = 0; i < 5; i++) stars.push({ "type": "icon", "size": "sm", "url": `https://scdn.line-apps.com/n/channel_devcenter/img/fx/review_${i < gold_stars ? "gold" : "gray"}_star_28.png` });

  return { "type": "flex", "altText": "你的分數", "contents": { "type": "bubble",
    "header": { "type": "box", "layout": "vertical", "contents": [{ "type": "image", "url": "https://cdn2.ettoday.net/images/5588/5588832.jpg", "size": "full", "aspectRatio": "2:1", "aspectMode": "cover" }], "paddingAll": "0px" },
    "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": [
      { "type": "text", "text": `你目前的得分為：${point}分` },
      { "type": "text", "text": `答錯次數：${wrong_answer}次\n\n` },
      { "type": "box", "layout": "baseline", "margin": "md", "contents": stars },
      { "type": "button", "action": { "type": "postback", "label": "繼續測驗", "data": `type=more_test&content=繼續測驗` }, "style": "primary" }
    ] }
  } };
}

function handleUrlParams(data) {
  const params = new URLSearchParams(data);
  return { wid: params.get('wid'), type: params.get('type'), question_type: params.get('question_type'), content: params.get('content') };
}

function getObjectItemIndex(object, id) {
  return object.findIndex(x => x.id == id);
}

function removeByIndex(array, index) {
  let newArray = [...array];
  newArray.splice(index, 1);
  return newArray;
}

/*==================================
 START APP
====================================*/
const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`listening on ${port} - Cloud Sheet Mode Active`); });