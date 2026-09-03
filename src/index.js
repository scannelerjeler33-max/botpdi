require('dotenv').config();
global.WebSocket = require('ws');
const { Client, GatewayIntentBits, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Inicializar el bot de Discord
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// --- LÓGICA DE INTERACCIONES DE BOTONES Y MODALES ---
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isButton()) {
            if (interaction.customId.startsWith('accept_int_')) {
                const userId = interaction.customId.split('_')[2];
                const member = await interaction.guild.members.fetch(userId).catch(() => null);
                
                if (member) {
                    const roles = ['1403933697576538173', '1437860236126982145', '1432090508540248268'];
                    await member.roles.add(roles).catch(console.error);
                    await member.send("Felicitaciones fuiste aceptado de interviewer, lee las normativas y comenza a tomar oposiciones y trabajar.").catch(() => null);
                }
                
                await interaction.update({ 
                    content: `✅ **Postulación aceptada** por <@${interaction.user.id}>`, 
                    components: [] 
                });
            }
            
            if (interaction.customId.startsWith('reject_int_')) {
                const userId = interaction.customId.split('_')[2];
                
                const modal = new ModalBuilder()
                    .setCustomId(`reject_modal_${userId}`)
                    .setTitle('Motivo de Rechazo');
                    
                const reasonInput = new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel("Motivo (se enviará al usuario)")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);
                    
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
            }
        }
        
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('reject_modal_')) {
                const userId = interaction.customId.split('_')[2];
                const reason = interaction.fields.getTextInputValue('reason');
                
                const member = await interaction.guild.members.fetch(userId).catch(() => null);
                if (member) {
                    await member.send(`Tu postulación para Interviewer ha sido rechazada.\n**Motivo:** ${reason}`).catch(() => null);
                }
                
                await interaction.update({ 
                    content: `❌ **Postulación rechazada** por <@${interaction.user.id}>\n**Motivo:** ${reason}`, 
                    components: [] 
                });
            }
        }
    } catch (e) {
        console.error("Error en interactionCreate:", e);
    }
});
// ---------------------------------------------------

client.once('ready', () => {
    console.log(`Bot conectado como ${client.user.tag}`);

    // Worker para revisar casos expirados cada 1 minuto (60000 ms)
    setInterval(async () => {
        try {
            const guildId = process.env.GUILD_ID;
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return;

            const expiredCases = await prisma.activeCase.findMany({
                where: {
                    closed: false,
                    expiresAt: { lte: new Date() }
                }
            });

            for (const caso of expiredCases) {
                try {
                    // Quitar rol
                    const member = await guild.members.fetch(caso.userId).catch(() => null);
                    if (member) {
                        await member.roles.remove(caso.roleId).catch(console.error);
                    }

                    // Actualizar Hilo a [CERRADO]
                    const channel = await client.channels.fetch('1519518326093774868').catch(() => null);
                    if (channel) {
                        const thread = await channel.threads.fetch(caso.threadId).catch(() => null);
                        if (thread && !thread.archived) {
                            await thread.edit({ name: `[CERRADO] ${thread.name}` }).catch(console.error);
                        }
                    }

                    // Marcar en DB como cerrado
                    await prisma.activeCase.update({
                        where: { id: caso.id },
                        data: { closed: true }
                    });
                    
                    console.log(`Caso ${caso.threadId} cerrado exitosamente.`);
                } catch (err) {
                    console.error("Error procesando caso expirado:", err);
                }
            }
        } catch (e) {
            console.error("Error en cron job de casos:", e);
        }
    }, 60000);
});

if (process.env.DISCORD_BOT_TOKEN) {
    client.login(process.env.DISCORD_BOT_TOKEN).catch(err => console.error('Error al conectar bot:', err));
} else {
    console.warn('No se proporcionó DISCORD_BOT_TOKEN');
}

// Configuración de Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// Configuración de Sesiones
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false
}));

// Configuración de Passport (Discord OAuth2)
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

if (process.env.DISCORD_CLIENT_ID) {
    passport.use(new DiscordStrategy({
        clientID: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        callbackURL: process.env.DISCORD_CALLBACK_URL,
        scope: ['identify', 'guilds', 'guilds.members.read']
    }, (accessToken, refreshToken, profile, done) => {
        return done(null, profile);
    }));
}

// Compartir el cliente de discord con las rutas (para verificar roles)
app.use((req, res, next) => {
    req.discordClient = client;
    next();
});

// Importar y usar rutas
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');

app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);

// Ruta principal
app.get('/', (req, res) => {
    res.render('index', { user: req.user });
});

app.listen(port, () => {
    console.log(`Servidor web escuchando en http://localhost:${port}`);
});
