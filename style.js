$(document).ready(function () {
    const formInputs = $('input[type="text"], input[type="password"], input[type="date"], input[type="time"], textarea');

    // Input focus/blur effects
    formInputs.focus(function () {
        $('#formWrapper').addClass('darken-bg');
        $('#google_translate_element').css({
            'background-color': 'rgb(117, 112, 112)',
            'border-radius': '0',
            'width': '100vw'
        });
        $('h1').css('color', '#44aacc');
    });

    formInputs.focusout(function () {
        $('#formWrapper').removeClass('darken-bg');
        $('#google_translate_element').css({
            'background-color': 'rgba(255, 255, 255, 0.9)',
            'border-radius': '0',
            'width': '100vw'
        });
        $('h1').css('color', '#2c3e50');
    });

    // Tab switching logic
$('.tab-button').on('click', function () {
    const targetTab = $(this).data('tab');
  
    $('.tab-button').removeClass('active');
    $(this).addClass('active');
  
    $('.tab-content').removeClass('active');
    $(`#tab-${targetTab}`).addClass('active');
  });
  
});
