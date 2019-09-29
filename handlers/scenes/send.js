require('dotenv').config();

const Composer = require('telegraf/composer');
const Markup = require('telegraf/markup');
const WizardScene = require('telegraf/scenes/wizard');

//utils
const _ = require('lodash');
const moment = require('moment');

//libs
const logger = require('../../lib/loggin');

//constants
const v = require('../../config/vars');

const CANCEL_TEXT = 'Back 🔙';
const CANCEL_MENU = Markup.keyboard([[CANCEL_TEXT]])
    .resize()
    .extra();
const MAIN_MENU = Markup.keyboard([
    ['➡️ Send $XRP', '📈 Market'],
    ['⚖️ Balance', '⬇️ Deposit', '⬆️ Withdraw'],
    ['🔔 Notificaiton', '👥 Contact'],
])
    .resize()
    .extra();

class SendHandler {
    constructor(app, db, stage) {
        this.app = app;
        this.db = db;
        this.ctx = null;
        this.stage = stage;
    }

    Cancel(ctx) {
        try {
            const { replyWithHTML, scene } = ctx;
            ctx.deleteMessage().catch(e => {});
            scene.leave();
            return replyWithHTML('ℹ️ Main Menu.', MAIN_MENU);
        } catch (e) {
            console.log('-- Cancel Error:');
        }
    }

    stepOne() {
        const stepOneHandler = new Composer();
        stepOneHandler.hears(CANCEL_TEXT, Composer.privateChat(this.Cancel));
        stepOneHandler.on(
            'message',
            Composer.privateChat(async ctx => {
                const message = ctx.update.message.text;
                const username = message.replace('@', '');

                const userModel = new this.db.User();
                const from_user = await userModel.getUser(ctx);

                if (!/[a-zA-Z0-9/_]{5,32}/.test(username)) {
                    return ctx.replyWithHTML('⚠️ Please enter a valid telegram username. Ex: @n3tc4t', CANCEL_MENU);
                }

                if (from_user.username) {
                    if (from_user.username.toLowerCase() === username.toLowerCase()) {
                        return ctx.replyWithHTML(`️️️️⚠️ You can not send XRP to yourself!`, CANCEL_MENU);
                    }
                }

                //set send username
                ctx.scene.session.state.username = username;

                ctx.wizard.next();
                return ctx.wizard.steps[ctx.wizard.cursor](ctx);
            }),
        );

        return stepOneHandler;
    }

    stepTwo() {
        const stepTwoHandler = new Composer();

        stepTwoHandler.hears(CANCEL_TEXT, Composer.privateChat(this.Cancel));
        stepTwoHandler.on(
            'message',
            Composer.privateChat(async ctx => {
                const { replyWithHTML } = ctx;
                let amount = ctx.update.message.text;

                const userModel = new this.db.User();
                const user = await userModel.getUser(ctx);

                if (amount === 'all') {
                    amount = user.balance;
                }

                if (user.balance === 0) {
                    return replyWithHTML("You don't have any XRP in your account , deposit with /deposit command");
                }

                if (!/^[+-]?\d+(\.\d+)?$/.test(amount)) {
                    return replyWithHTML(`<b>Invalid Amount, please enter number.</b>`, CANCEL_MENU);
                } else {
                    //valid amount
                    if (parseFloat(amount) < 0.000001) {
                        return replyWithHTML(`<b>The minimum amount to send is 0.000001 XRP!</b>`, CANCEL_MENU);
                    }
                    if (parseFloat(user.balance) < parseFloat(amount)) {
                        //Insufficient fund
                        return replyWithHTML(`<b>Insufficient Balance</b>`, CANCEL_MENU);
                    }
                }

                //set withdraw amount
                ctx.scene.session.state.amount = amount;

                ctx.wizard.next();
                return ctx.wizard.steps[ctx.wizard.cursor](ctx);
            }),
        );

        return stepTwoHandler;
    }

    stepThree() {
        const stepThreeHandler = new Composer();

        stepThreeHandler.hears(CANCEL_TEXT, Composer.privateChat(this.Cancel));
        stepThreeHandler.action('confirm-send-no', Composer.privateChat(this.Cancel));

        stepThreeHandler.action(
            'confirm-send-yes',
            Composer.privateChat(async ctx => {
                const { replyWithHTML } = ctx;
                const { state } = ctx.scene.session;

                const unlock = await ctx.session.lock();

                try {
                    const userModel = new this.db.User();

                    const from_user = await userModel.getUser(ctx);
                    const to_user = await userModel.getUserByUsername(state.username);

                    logger.info(
                        `Send - ${from_user.username}:${from_user.id} -> ${to_user.username}:${to_user.id} - ${
                            state.amount
                        }`,
                    );

                    // change balances
                    const sender_balance = await userModel.decreaseBalance(from_user, state.amount);
                    const recipient_balance = await userModel.increaseBalance(to_user, state.amount);

                    const datetime = moment().format(v.DATE_FORMAT);

                    // create transaction
                    await this.db.Transaction.create({
                        amount: state.amount,
                        type: 'direct',
                        sender_username: from_user.username,
                        recipient_username: to_user.username,
                        from_user: from_user.id,
                        to_user: to_user.id,
                        datetime,
                    });

                    const marketModel = new this.db.Market();
                    const toUSD = await marketModel.calculate(state.amount, 'USD');
                    let usd = '';

                    if (toUSD !== 0) {
                        usd = `(${toUSD} USD)`;
                    }

                    // send message to recipient if there is any telegram id
                    if (to_user.telegramId) {
                        this.app.telegram
                            .sendMessage(
                                to_user.telegramId,
                                `️️️️️️️You received <b>${state.amount} XRP</b> ${usd} from @${
                                    from_user.username
                                }\nYour new balance is <b>${recipient_balance} XRP</b>`,
                                { parse_mode: 'HTML' },
                            )
                            .catch(e => {});
                    }

                    return replyWithHTML(
                        `✅ <b>${state.amount} XRP</b> ${usd} Successfully sent to @${to_user.username}!`,
                    );
                } catch (err) {
                    logger.error(`Send Error - ${err}`);
                    replyWithHTML(`<b>Something is wrong on sending XRP , please report the problem.</b>`, MAIN_MENU);
                } finally {
                    // unlock after everything is done
                    unlock();
                    ctx.deleteMessage().catch(e => {});
                    ctx.scene.leave();
                    return replyWithHTML('ℹ️ Main Menu.', MAIN_MENU);
                }
            }),
        );

        return stepThreeHandler;
    }

    async setWizard() {
        await this.stage.register(
            new WizardScene(
                'send',
                ctx => {
                    ctx.replyWithHTML('Please respond to us with a valid telegram <b>username</b>', CANCEL_MENU);
                    return ctx.wizard.next();
                },
                this.stepOne(),
                ctx => {
                    ctx.replyWithHTML('How much XRP do you want to send?', CANCEL_MENU);
                    return ctx.wizard.next();
                },
                this.stepTwo(),
                ctx => {
                    const { state } = ctx.scene.session;
                    ctx.replyWithHTML(
                        `<b>CONFIRM</b>\n\nYou want to send <b>${state.amount} XRP</b> to <b>@${
                            state.username
                        }</b> is this correct?`,
                        Markup.inlineKeyboard([
                            Markup.callbackButton('Yes', 'confirm-send-yes'),
                            Markup.callbackButton('No', 'confirm-send-no'),
                        ]).extra(),
                    );
                    return ctx.wizard.next();
                },
                this.stepThree(),
            ),
        );
    }

    setHandler() {
        this.app.hears(
            '➡️ Send $XRP',
            Composer.privateChat(async ctx => {
                const { scene } = ctx;
                scene.enter('send');
            }),
        );
    }
}

module.exports = SendHandler;
